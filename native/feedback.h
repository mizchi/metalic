#pragma once

#ifdef METALIC_FEEDBACK_EXPERIMENT
// Compiled only into frontend-feedback. Both resident and checkpoint variants
// fingerprint identical kernels, scalar parameters, sizes and launch bounds.
struct FeedbackTrace {
  U32 every;
  uint64_t signature=14695981039346656037ull;
  double gpuUs=0;
  NSMutableArray* samples=[NSMutableArray new];
  explicit FeedbackTrace(U32 interval) : every(interval) {}
  void hash(const void* bytes,size_t count) {
    auto data=static_cast<const unsigned char*>(bytes);
    for(size_t i=0;i<count;i++) { signature^=data[i]; signature*=1099511628211ull; }
  }
  void dispatch(NSString* kernel,U32 groups,const Params& params) {
    const char* name=kernel.UTF8String;
    hash(name,strlen(name)+1); hash(&groups,sizeof(groups)); hash(&params,sizeof(params));
  }
  void checkpoint(id<MTLCommandBuffer> command,BufferLease& lease,U32* control,U32 dispatches) {
    uint64_t start=mach_absolute_time();
    lease.submitted(command);
    [command commit];
    [command waitUntilCompleted];
    check(command.status==MTLCommandBufferStatusCompleted,
      command.error ? command.error.localizedDescription.UTF8String : "Feedback command failed");
    uint64_t reading=mach_absolute_time();
    volatile const U32* counts=control;
    U32 tokens=counts[CTokenCount],nodes=counts[CNodeCount];
    uint64_t read=mach_absolute_time();
    double deviceUs=(command.GPUEndTime-command.GPUStartTime)*1e6;
    gpuUs+=deviceUs;
    [samples addObject:@{@"dispatches":@(dispatches),@"tokenCount":@(tokens),@"nodeCount":@(nodes),
      @"elapsedUs":@(elapsed(start,read)),@"readUs":@(elapsed(reading,read)),@"gpuUs":@(deviceUs)}];
    // Counts are observed but never change the next kernel or launch bound.
  }
  void publish(NSMutableDictionary* result) const {
    result[@"feedbackEvery"]=@(every); result[@"feedbackWaits"]=@(samples.count);
    result[@"hostWaits"]=@(samples.count+1); result[@"feedbackSamples"]=samples;
    result[@"dispatchSignature"]=[NSString stringWithFormat:@"%016llx",(unsigned long long)signature];
  }
};
#endif
