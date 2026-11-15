#pragma once

// CPU orchestration of independent input snapshots. FIFO draining bounds both
// GPU submissions and arenas awaiting CPU consumption; result order is stable.
static NSArray* runBatch(Runtime& runtime,NSArray* sources,const std::vector<Configuration>& configurations,
    U32 chunk,U32 repeat,bool moduleMode,bool poisonBuffers,U32 maxInFlight,bool summary) {
  NSMutableArray* results=[NSMutableArray new];
  for(U32 i=0;i<sources.count*configurations.size();i++)
    [results addObject:[@{@"samplesUs":[NSMutableArray new],@"gpuSamplesUs":[NSMutableArray new],
      @"timingSamplesUs":[NSMutableArray new],@"allocationSamples":[NSMutableArray new],
      @"flightSamples":[NSMutableArray new]} mutableCopy]];
  // Destruction order matters on failure: pending futures wait and release
  // their leases before the Runtime (and its pools) can be destroyed.
  std::deque<std::unique_ptr<Flight>> pending;
  uint64_t batchStart=mach_absolute_time();
  U32 sequence=0,peakLeasedSlots=0;
  size_t peakBufferBytes=0;
  auto drain=[&] {
    @autoreleasepool {
      auto& flight=pending.front();
      NSMutableDictionary* current=flight->finish(batchStart);
      NSMutableDictionary* result=results[flight->resultIndex];
      [result[@"samplesUs"] addObject:current[@"elapsedUs"]];
      [result[@"gpuSamplesUs"] addObject:current[@"gpuUs"]];
      [result[@"timingSamplesUs"] addObject:current[@"timingsUs"]];
      [result[@"allocationSamples"] addObject:current[@"bufferAllocations"]];
      [result[@"flightSamples"] addObject:current[@"flight"]];
      [current removeObjectForKey:@"flight"];
      [result addEntriesFromDictionary:current];
      pending.pop_front(); // CPU objects no longer refer to the arena.
    }
  };
  for(U32 sourceIndex=0;sourceIndex<sources.count;sourceIndex++) {
    id source=sources[sourceIndex];
    check([source isKindOfClass:[NSString class]],"Source must be a string");
    for(U32 run=0;run<repeat;run++) {
      // Rotate order each round, comparing schedules with the same device,
      // library and process rather than timing separate process lifetimes.
      for(U32 order=0;order<configurations.size();order++) {
        U32 index=(order+run)%U32(configurations.size());
        @autoreleasepool {
          if(pending.size()==maxInFlight) drain();
          auto config=configurations[index];
          auto flight=runtime.submit(source,chunk,run+1==repeat,moduleMode,config.diagnostics,config.buffers,
            poisonBuffers,sequence%maxInFlight,summary);
          flight->sequence=sequence++;
          flight->resultIndex=sourceIndex*U32(configurations.size())+index;
          pending.push_back(std::move(flight));
          peakLeasedSlots=std::max(peakLeasedSlots,U32(pending.size()));
          size_t allocated=runtime.retainedBytes();
          for(const auto& active:pending) if(active->fresh) allocated+=active->bytes();
          peakBufferBytes=std::max(peakBufferBytes,allocated);
        }
      }
    }
  }
  while(!pending.empty()) drain();
  double batchWallUs=elapsed(batchStart,mach_absolute_time());
  NSDictionary* batch=@{@"maxInFlight":@(maxInFlight),@"peakLeasedSlots":@(peakLeasedSlots),
    @"jobs":@(sequence),@"wallUs":@(batchWallUs),@"peakBufferBytes":@(peakBufferBytes)};
  for(NSMutableDictionary* result in results) { result[@"setupUs"]=@(runtime.setupUs); result[@"batch"]=batch; }
  return results;
}
