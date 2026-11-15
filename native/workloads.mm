#include "workloads_runtime.h"

int main(int argc,const char** argv) {
  @autoreleasepool {
    try {
      check(argc==2,"usage: workloads-metal <native-directory>; JSON on stdin");
      mach_timebase_info_data_t time; mach_timebase_info(&time); nsPerTick=double(time.numer)/time.denom;
      NSError* error=nil;
      auto input=[[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
      id request=[NSJSONSerialization JSONObjectWithData:input options:0 error:&error];
      check([request isKindOfClass:[NSDictionary class]],"Expected workload request");
      NSArray* jobs=request[@"jobs"];
      check([jobs isKindOfClass:[NSArray class]] && jobs.count<=MaxWorkloadJobs,"Expected at most 64 jobs");
      U32 warmups=number(request[@"warmups"],3,0,10,"Invalid warmups"),samples=number(request[@"samples"],15,1,100,"Invalid samples");
      bool poison=boolean(request[@"poisonBuffers"],"poisonBuffers must be boolean"),full=boolean(request[@"includeOutput"],"includeOutput must be boolean");
      NSArray* modes=request[@"modes"] ?: @[@"cpu-serial",@"cpu-parallel",@"gpu-resident",@"gpu-upload"];
      check([modes isKindOfClass:[NSArray class]] && modes.count && modes.count<=4 && [NSSet setWithArray:modes].count==modes.count,"Invalid modes");
      for(id mode in modes) check([@[@"cpu-serial",@"cpu-parallel",@"gpu-resident",@"gpu-upload"] containsObject:mode],"Unknown mode");
      WorkloadRuntime runtime(@(argv[1]));
      NSMutableArray* records=[NSMutableArray new];
      for(id job in jobs) @autoreleasepool { [records addObjectsFromArray:runtime.run(job,modes,warmups,samples,poison,full)]; }
      auto output=[NSJSONSerialization dataWithJSONObject:@{@"device":runtime.name(),@"mslVersion":@"4.0",@"cpuThreads":@(runtime.threads),
        @"setupUs":@(runtime.setupUs),@"records":records} options:0 error:&error];
      check(output!=nil,"Cannot serialize workload results");
      fwrite(output.bytes,1,output.length,stdout); fputc('\n',stdout);
    } catch(const std::exception& error) { fprintf(stderr,"metalic-workloads: %s\n",error.what()); return 1; }
  }
}
