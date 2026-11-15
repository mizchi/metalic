#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <dispatch/dispatch.h>
#include <mach/mach_time.h>
#include <algorithm>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>
#include "contract.h"
#include "buffers.h"

static double nsPerTick;
static double elapsed(uint64_t begin,uint64_t end) { return (end-begin)*nsPerTick/1000.0; }
static void check(bool condition,const std::string& message) { if(!condition) throw std::runtime_error(message); }
static U32 number(id value,U32 fallback,U32 low,U32 high,const char* name) {
  if(!value) return fallback;
  check([value isKindOfClass:[NSNumber class]] && CFGetTypeID((__bridge CFTypeRef)value)!=CFBooleanGetTypeID() &&
    [value doubleValue]>=low && [value doubleValue]<=high && [value doubleValue]==[value unsignedLongLongValue],name);
  return [value unsignedIntValue];
}
static bool boolean(id value,const char* name) {
  check(!value || CFGetTypeID((__bridge CFTypeRef)value)==CFBooleanGetTypeID(),name);
  return [value boolValue];
}
#include "workloads_cpu.h"
#include "workloads_plan.h"
static_assert(sizeof(WorkloadParams)==32 && offsetof(WorkloadParams,countOffset)==24);

static NSString* hex(const void* input,size_t count) {
  auto bytes=static_cast<const unsigned char*>(input);
  std::string result(count*2,'0'); const char* digits="0123456789abcdef";
  for(size_t i=0;i<count;i++) { result[2*i]=digits[bytes[i]>>4]; result[2*i+1]=digits[bytes[i]&15]; }
  return [NSString stringWithUTF8String:result.c_str()];
}
static WorkloadJob parseJob(NSDictionary* spec) {
  check([spec isKindOfClass:[NSDictionary class]],"Expected workload object");
  id name=spec[@"algorithm"];
  Workload kind; U32 limit;
  if([name isEqual:@"merkle-sha256"]) { kind=Workload::Merkle; limit=MaxMerkleLeaves; }
  else if([name isEqual:@"histogram256"]) { kind=Workload::Histogram; limit=MaxHistogramBytes; }
  else { check([name isEqual:@"compact-u32"],"Unknown workload algorithm"); kind=Workload::Compact; limit=MaxCompactValues; }
  check(spec[@"count"]!=nil,"Missing workload count");
  U32 n=number(spec[@"count"],0,0,limit,"Invalid workload count");
  id distribution=spec[@"distribution"];
  check(!distribution || [distribution isEqual:@"uniform"] || [distribution isEqual:@"hot"],"Unknown distribution");
  bool hot=[distribution isEqual:@"hot"];
  check(!hot || kind==Workload::Histogram,"hot distribution requires histogram256");
  size_t bytes=size_t(n)*(kind==Workload::Merkle ? 64 : kind==Workload::Compact ? 4 : 1);
  WorkloadJob job{kind,n,number(spec[@"seed"],0x12345678,0,0xffffffffu,"seed must be u32"),
    number(spec[@"mask"],1,0,0xffffffffu,"mask must be u32"),hot,bytes,{}};
  job.input.resize(std::max((bytes+3)/4,size_t(1)));
  U32 state=job.seed;
  if(kind==Workload::Compact) for(U32 i=0;i<n;i++) job.input[i]=nextRandom(state);
  else {
    auto data=reinterpret_cast<unsigned char*>(job.input.data());
    for(size_t i=0;i<bytes;i++) data[i]=hot ? 7 : nextRandom(state)&255;
  }
  return job;
}

class WorkloadRuntime {
  id<MTLDevice> device;
  id<MTLCommandQueue> queue;
  NSMutableDictionary<NSString*,id<MTLComputePipelineState>>* pipelines;
  BufferPool pool;
public:
  double setupUs;
  U32 threads=U32(std::max(NSProcessInfo.processInfo.activeProcessorCount,NSUInteger(1)));
  explicit WorkloadRuntime(NSString* directory) {
    uint64_t start=mach_absolute_time();
    device=MTLCreateSystemDefaultDevice();
    check(device && device.hasUnifiedMemory,"A unified-memory Metal GPU is required");
    queue=[device newCommandQueue]; check(queue!=nil,"Cannot create Metal queue");
    NSError* error=nil;
    auto header=[NSString stringWithContentsOfFile:[directory stringByAppendingPathComponent:@"contract.h"] encoding:NSUTF8StringEncoding error:&error];
    auto body=[NSString stringWithContentsOfFile:[directory stringByAppendingPathComponent:@"workloads.metal"] encoding:NSUTF8StringEncoding error:&error];
    check(header && body,"Cannot load workload shader sources");
    auto source=[[@"#include <metal_stdlib>\nusing namespace metal;\n" stringByAppendingString:header] stringByAppendingString:body];
    auto options=[MTLCompileOptions new]; options.languageVersion=MTLLanguageVersion4_0;
    auto library=[device newLibraryWithSource:source options:options error:&error];
    check(library!=nil,error ? error.localizedDescription.UTF8String : "Workload shader compilation failed");
    pipelines=[NSMutableDictionary new];
    for(NSString* name in @[@"sha_leaves",@"sha_parents",@"sha_empty",@"histogram_partials",@"histogram_finish",
        @"compact_scan",@"scan_values",@"workload_scan_add",@"compact_scatter"]) {
      auto pso=[device newComputePipelineStateWithFunction:[library newFunctionWithName:name] error:&error];
      check(pso!=nil,error ? error.localizedDescription.UTF8String : "Missing workload kernel");
      check(pso.threadExecutionWidth==32 && pso.maxTotalThreadsPerThreadgroup>=256,
        "Workload kernels require SIMD width 32 and 256-thread groups");
      check(pso.staticThreadgroupMemoryLength<=device.maxThreadgroupMemoryLength,"Insufficient threadgroup memory");
      pipelines[name]=pso;
    }
    setupUs=elapsed(start,mach_absolute_time());
  }
  NSString* name() const { return device.name; }

  NSArray* run(NSDictionary* spec,NSArray* modes,U32 warmups,U32 samples,bool poison,bool includeOutput) {
    WorkloadJob job=parseJob(spec);
    check(!includeOutput || job.kind!=Workload::Compact || job.count<=MaxWorkloadOutput,"Full output exceeds 8192 elements");
    CpuWorkload cpu(job,threads);
    cpu.run(job,false);
    const U32 expectedCount=cpu.resultCount;
    const std::vector<U32> expected(cpu.output.begin(),cpu.output.begin()+expectedCount);
    unsigned char inputHash[32]; CC_SHA256(job.input.data(),CC_LONG(job.inputBytes),inputHash);
    WorkloadPlan plan(job);
    check(size_t(plan.words)*4<=device.maxBufferLength && job.inputBytes+64<=device.maxBufferLength,"Workload exceeds Metal buffer limit");
    uint64_t acquiring=mach_absolute_time();
    auto lease=acquireBuffers(device,&pool,std::max(job.inputBytes,size_t(1))+64,size_t(plan.words)*4);
    double acquireUs=elapsed(acquiring,mach_absolute_time());
    lease.source.label=@"workload input"; lease.arena.label=@"workload arena";
    if(job.inputBytes) memcpy(lease.source.contents,job.input.data(),job.inputBytes);
    auto arena=static_cast<U32*>(lease.arena.contents);
    NSMutableArray* records=[NSMutableArray new];
    for(NSString* mode in modes) {
      [records addObject:[@{@"algorithm":spec[@"algorithm"],@"count":@(job.count),@"seed":@(job.seed),@"mask":@(job.mask),
        @"distribution":job.hot ? @"hot" : @"uniform",@"mode":mode,@"inputBytes":@(job.inputBytes),@"inputHash":hex(inputHash,32),
        @"arenaBytes":@(size_t(plan.words)*4),@"bufferBytes":@(lease.source.length+lease.arena.length),
        @"acquireUs":@(acquireUs),@"samples":[NSMutableArray new],@"verified":@YES} mutableCopy]];
    }
    for(U32 round=0;round<warmups+samples;round++) for(U32 order=0;order<modes.count;order++) {
      U32 index=(round+order)%U32(modes.count);
      @autoreleasepool {
        NSString* mode=modes[index];
        bool gpu=[mode hasPrefix:@"gpu"],upload=[mode isEqual:@"gpu-upload"];
        if(gpu && poison) {
          memset(lease.source.contents,0xa5,lease.source.length); memset(arena,0xa5,lease.arena.length);
          if(job.inputBytes) memcpy(lease.source.contents,job.input.data(),job.inputBytes);
        }
        uint64_t start=mach_absolute_time(),prepared=start,encoded=start,computed=start,consumed;
        const U32* output; U32 count=0; double gpuUs=0;
        if(gpu) {
          if(upload && job.inputBytes) memcpy(lease.source.contents,job.input.data(),job.inputBytes);
          prepared=mach_absolute_time();
          auto command=[queue commandBuffer]; command.label=spec[@"algorithm"];
          auto encoder=[command computeCommandEncoder]; check(command && encoder,"Cannot create workload commands");
          [encoder setBuffer:lease.source offset:0 atIndex:0]; [encoder setBuffer:lease.arena offset:0 atIndex:1];
          for(const auto& dispatch:plan.dispatches) {
            [encoder setComputePipelineState:pipelines[dispatch.kernel]];
            [encoder setBytes:&dispatch.params length:sizeof(dispatch.params) atIndex:2];
            [encoder dispatchThreadgroups:MTLSizeMake(dispatch.groups ? dispatch.groups : (dispatch.threads+255)/256,1,1)
              threadsPerThreadgroup:MTLSizeMake(256,1,1)];
            [encoder memoryBarrierWithScope:MTLBarrierScopeBuffers];
          }
          [encoder endEncoding]; encoded=mach_absolute_time();
          lease.submitted(command); [command commit]; [command waitUntilCompleted];
          computed=mach_absolute_time();
          check(command.status==MTLCommandBufferStatusCompleted,command.error ? command.error.localizedDescription.UTF8String : "GPU workload failed");
          gpuUs=(command.GPUEndTime-command.GPUStartTime)*1e6;
          count=job.kind==Workload::Compact ? arena[plan.countOffset] : plan.resultCount;
          check(count<=(job.kind==Workload::Compact ? job.count : plan.resultCount),"GPU output exceeds capacity");
          output=arena+plan.output;
        } else {
          cpu.run(job,[mode isEqual:@"cpu-parallel"]); computed=mach_absolute_time();
          output=cpu.output.data(); count=cpu.resultCount;
        }
        U32 checksum=workloadChecksum(output,count);
        consumed=mach_absolute_time();
        // Verify AFTER the measured consumer. Every mode creates the same full
        // output, with no extra copy forced on CPU and no GPU-only shortcut.
        check(count==expectedCount && (!count || !memcmp(output,expected.data(),size_t(count)*4)),"CPU/GPU workload mismatch");
        if(gpu && poison) {
          plan.checkGuards(arena);
          const auto bytes=static_cast<const unsigned char*>(lease.source.contents);
          for(size_t j=job.inputBytes;j<job.inputBytes+64;j++) check(bytes[j]==0xa5,"Input guard was modified");
        }
        if(round<warmups) continue;
        NSMutableDictionary* result=records[index];
        [result[@"samples"] addObject:@{@"elapsedUs":@(elapsed(start,consumed)),@"prepareUs":@(gpu ? elapsed(start,prepared) : 0),
          @"encodeUs":@(gpu ? elapsed(prepared,encoded) : 0),@"waitUs":@(gpu ? elapsed(encoded,computed) : 0),
          @"computeUs":@(gpu ? gpuUs : elapsed(start,computed)),@"gpuUs":@(gpuUs),@"consumeUs":@(elapsed(computed,consumed))}];
        result[@"resultCount"]=@(count); result[@"checksum"]=@(checksum); result[@"hostWaits"]=@(gpu ? 1 : 0);
        result[@"dispatches"]=@(gpu ? plan.dispatches.size() : 0); result[@"cpuWorkers"]=@(gpu ? 0 : cpu.workers);
        if(job.kind==Workload::Merkle) result[@"digestHex"]=hex(output,32);
        if(includeOutput && round+1==warmups+samples) {
          NSMutableArray* data=[NSMutableArray new]; for(U32 j=0;j<count;j++) [data addObject:@(output[j])];
          result[@"output"]=data;
        }
      }
    }
    return records; // No GPU-backed pointer escapes; the lease is returned now.
  }
};

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
