#include "workloads_runtime.h"
#include <iostream>
#include <unordered_map>

static size_t memoryLimit(id value) {
  check([value isKindOfClass:[NSNumber class]] && CFGetTypeID((__bridge CFTypeRef)value)!=CFBooleanGetTypeID() &&
    [value doubleValue]>=16384 && [value doubleValue]<=1099511627776.0 &&
    [value doubleValue]==[value unsignedLongLongValue],"Invalid memory budget");
  return [value unsignedLongLongValue];
}
static void reply(NSDictionary* response) {
  NSError* error=nil;
  auto data=[NSJSONSerialization dataWithJSONObject:response options:0 error:&error];
  check(data!=nil,"Cannot encode worker response");
  fwrite(data.bytes,1,data.length,stdout); fputc('\n',stdout); fflush(stdout);
}

int main(int argc,const char** argv) {
  @autoreleasepool {
    try {
      check(argc==3 && (std::string(argv[2])=="cpu" || std::string(argv[2])=="gpu"),"usage: workload-worker <native-directory> cpu|gpu");
      mach_timebase_info_data_t time; mach_timebase_info(&time); nsPerTick=double(time.numer)/time.denom;
      bool gpu=std::string(argv[2])=="gpu";
      WorkloadRuntime runtime(@(argv[1]),gpu);
      // Prepared resources are destroyed BEFORE the runtime, including on EOF.
      std::unordered_map<std::string,std::unique_ptr<PreparedWorkload>> prepared;
      size_t reserved=0;
      std::string line;
      while(std::getline(std::cin,line)) @autoreleasepool {
        id requestId=@0;
        try {
          check(line.size()<=1048576,"Worker request exceeds 1 MiB");
          auto data=[NSData dataWithBytes:line.data() length:line.size()];
          id request=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
          check([request isKindOfClass:[NSDictionary class]],"Expected worker request");
          requestId=request[@"id"] ?: @0;
          id op=request[@"op"]; NSDictionary* value=nil;
          if([op isEqual:@"info"]) {
            value=@{@"role":@(argv[2]),@"device":runtime.name(),@"cpuThreads":@(runtime.threads),
              @"mslVersion":@"4.0",@"protocol":@1,@"setupUs":@(runtime.setupUs),@"pid":@(NSProcessInfo.processInfo.processIdentifier)};
          } else if([op isEqual:@"estimate"]) {
            value=@{@"bytes":@(workloadEstimate(request[@"spec"],runtime.threads,gpu))};
          } else if([op isEqual:@"prepare"]) {
            check([request[@"handle"] isKindOfClass:[NSString class]],"Missing handle");
            std::string key=[request[@"handle"] UTF8String];
            check(!prepared.count(key) && prepared.size()<64,"Duplicate handle or too many prepared inputs");
            size_t estimate=workloadEstimate(request[@"spec"],runtime.threads,gpu),limit=memoryLimit(request[@"budgetBytes"]);
            check(estimate<=limit && reserved<=limit-estimate,"Prepared workload exceeds memory budget");
            uint64_t start=mach_absolute_time();
            auto state=runtime.prepare(request[@"spec"]);
            check(state->bytes()<=estimate,"Prepared allocation exceeded its reservation");
            value=@{@"bytes":@(estimate),@"inputHash":state->inputHash,@"feature":state->feature(),
              @"prepareUs":@(elapsed(start,mach_absolute_time()))};
            reserved+=estimate; prepared.emplace(key,std::move(state));
          } else if([op isEqual:@"run"] || [op isEqual:@"release"]) {
            check([request[@"handle"] isKindOfClass:[NSString class]],"Missing handle");
            std::string key=[request[@"handle"] UTF8String];
            auto found=prepared.find(key); check(found!=prepared.end(),"Unknown prepared handle");
            if([op isEqual:@"release"]) {
              size_t estimate=workloadEstimate(found->second->spec,runtime.threads,gpu);
              prepared.erase(found); reserved-=estimate; value=@{};
            } else {
              id mode=request[@"mode"];
              check(gpu ? ([mode isEqual:@"gpu-upload"] || [mode isEqual:@"gpu-resident"]) :
                ([mode isEqual:@"cpu-serial"] || [mode isEqual:@"cpu-parallel"]),"Mode does not match worker role");
              bool poison=boolean(request[@"poisonBuffers"],"poisonBuffers must be boolean");
              uint64_t start=mach_absolute_time();
              auto records=runtime.execute(*found->second,@[mode],0,1,poison,false);
              value=@{@"record":records[0],@"nativeServiceUs":@(elapsed(start,mach_absolute_time())),@"pid":@(NSProcessInfo.processInfo.processIdentifier)};
            }
          } else if([op isEqual:@"shutdown"]) {
            prepared.clear(); reply(@{@"id":requestId,@"ok":@YES,@"value":@{}}); return 0;
          } else throw std::runtime_error("Unknown worker operation");
          reply(@{@"id":requestId,@"ok":@YES,@"value":value});
        } catch(const std::exception& error) {
          reply(@{@"id":requestId,@"ok":@NO,@"error":@(error.what())});
          // Never hide a failed GPU or validation by retrying on another backend.
          return 1;
        }
      }
    } catch(const std::exception& error) { fprintf(stderr,"metalic-worker: %s\n",error.what()); return 1; }
  }
}
