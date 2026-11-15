#pragma once
#include <memory>
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
static WorkloadJob parseJob(NSDictionary* spec,bool generate=true) {
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
  if(!generate) return job;
  job.input.resize(std::max((bytes+3)/4,size_t(1)));
  U32 state=job.seed;
  if(kind==Workload::Compact) for(U32 i=0;i<n;i++) job.input[i]=nextRandom(state);
  else {
    auto data=reinterpret_cast<unsigned char*>(job.input.data());
    for(size_t i=0;i<bytes;i++) data[i]=hot ? 7 : nextRandom(state)&255;
  }
  return job;
}

struct PreparedWorkload {
  NSDictionary* spec;
  WorkloadJob job;
  CpuWorkload cpu;
  WorkloadPlan plan;
  std::vector<U32> expected;
  NSString* inputHash;
  std::unique_ptr<BufferLease> lease;
  double acquireUs=0;
  PreparedWorkload(NSDictionary* input,U32 threads)
    : spec([input copy]),job(parseJob(input)),cpu(job,threads),plan(job) {
    cpu.run(job,false);
    expected.assign(cpu.output.begin(),cpu.output.begin()+cpu.resultCount);
    unsigned char hash[32]; CC_SHA256(job.input.data(),CC_LONG(job.inputBytes),hash);
    inputHash=hex(hash,32);
  }
  size_t bytes() const {
    size_t words=job.input.capacity()+cpu.output.capacity()+cpu.a.capacity()+cpu.b.capacity()+
      cpu.counts.capacity()+cpu.offsets.capacity()+expected.capacity();
    return words*4+cpu.hist.capacity()*sizeof(HistogramScratch)+16384+
      (lease ? lease->source.length+lease->arena.length : 0);
  }
  NSString* feature() const {
    if(!job.count) return @"empty";
    if(job.kind==Workload::Merkle) return @"fixed";
    if(job.kind==Workload::Histogram) {
      uint64_t peak=*std::max_element(expected.begin(),expected.end());
      return peak*4>=job.count ? @"skewed" : peak*64>=job.count ? @"mixed" : @"balanced";
    }
    uint64_t count=expected.size();
    return !count ? @"none" : count==job.count ? @"all" : count*8<job.count ? @"sparse" :
      count*8>uint64_t(job.count)*7 ? @"dense" : @"mixed";
  }
};

inline size_t workloadEstimate(NSDictionary* spec,U32 threads,bool gpu) {
  auto job=parseJob(spec,false); WorkloadPlan plan(job);
  size_t output=job.kind==Workload::Merkle ? 32 : job.kind==Workload::Histogram ? 1024 : size_t(std::max(job.count,1u))*4;
  size_t bytes=std::max((job.inputBytes+3)/4,size_t(1))*4+2*output+
    threads*4*(sizeof(HistogramScratch)+8)+16384;
  if(job.kind==Workload::Merkle) bytes+=size_t(std::max(job.count,1u)+std::max((job.count+1)/2,1u))*32;
  if(gpu) bytes+=std::max(job.inputBytes,size_t(1))+64+size_t(plan.words)*4;
  return bytes;
}

class WorkloadRuntime {
  id<MTLDevice> device=nil;
  id<MTLCommandQueue> queue=nil;
  NSMutableDictionary<NSString*,id<MTLComputePipelineState>>* pipelines;
  BufferPool pool;
public:
  double setupUs;
  U32 threads=U32(std::max(NSProcessInfo.processInfo.activeProcessorCount,NSUInteger(1)));
  explicit WorkloadRuntime(NSString* directory,bool enableGPU=true) {
    uint64_t start=mach_absolute_time();
    if(!enableGPU) { setupUs=elapsed(start,mach_absolute_time()); return; }
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
  NSString* name() const { return device ? device.name : @"CPU"; }

  std::unique_ptr<PreparedWorkload> prepare(NSDictionary* spec,BufferPool* reuse=nullptr) {
    auto state=std::make_unique<PreparedWorkload>(spec,threads);
    if(device) {
      auto& job=state->job; auto& plan=state->plan;
      check(size_t(plan.words)*4<=device.maxBufferLength && job.inputBytes+64<=device.maxBufferLength,"Workload exceeds Metal buffer limit");
      uint64_t acquiring=mach_absolute_time();
      state->lease.reset(new BufferLease(acquireBuffers(device,reuse,std::max(job.inputBytes,size_t(1))+64,size_t(plan.words)*4)));
      state->acquireUs=elapsed(acquiring,mach_absolute_time());
      state->lease->source.label=@"workload input"; state->lease->arena.label=@"workload arena";
      if(job.inputBytes) memcpy(state->lease->source.contents,job.input.data(),job.inputBytes);
    }
    return state;
  }
  NSArray* run(NSDictionary* spec,NSArray* modes,U32 warmups,U32 samples,bool poison,bool includeOutput) {
    auto state=prepare(spec,&pool);
    return execute(*state,modes,warmups,samples,poison,includeOutput);
  }
  NSArray* execute(PreparedWorkload& state,NSArray* modes,U32 warmups,U32 samples,bool poison,bool includeOutput) {
    auto& job=state.job; auto& cpu=state.cpu; auto& plan=state.plan; auto& expected=state.expected;
    auto spec=state.spec;
    check(!includeOutput || job.kind!=Workload::Compact || job.count<=MaxWorkloadOutput,"Full output exceeds 8192 elements");
    U32 expectedCount=U32(expected.size());
    id<MTLBuffer> source=state.lease ? state.lease->source : nil,arenaBuffer=state.lease ? state.lease->arena : nil;
    auto arena=static_cast<U32*>(arenaBuffer.contents);
    double acquireUs=state.acquireUs;
    NSMutableArray* records=[NSMutableArray new];
    for(NSString* mode in modes) {
      [records addObject:[@{@"algorithm":spec[@"algorithm"],@"count":@(job.count),@"seed":@(job.seed),@"mask":@(job.mask),
        @"distribution":job.hot ? @"hot" : @"uniform",@"mode":mode,@"inputBytes":@(job.inputBytes),@"inputHash":state.inputHash,
        @"arenaBytes":@(size_t(plan.words)*4),@"bufferBytes":@(source.length+arenaBuffer.length),
        @"acquireUs":@(acquireUs),@"samples":[NSMutableArray new],@"verified":@YES} mutableCopy]];
    }
    for(U32 round=0;round<warmups+samples;round++) for(U32 order=0;order<modes.count;order++) {
      U32 index=(round+order)%U32(modes.count);
      @autoreleasepool {
        NSString* mode=modes[index];
        bool gpu=[mode hasPrefix:@"gpu"],upload=[mode isEqual:@"gpu-upload"];
        check(!gpu || state.lease!=nullptr,"GPU mode is unavailable on CPU worker");
        if(gpu && poison) {
          memset(source.contents,0xa5,source.length); memset(arena,0xa5,arenaBuffer.length);
          if(job.inputBytes) memcpy(source.contents,job.input.data(),job.inputBytes);
        }
        uint64_t start=mach_absolute_time(),prepared=start,encoded=start,computed=start,consumed;
        const U32* output; U32 count=0; double gpuUs=0;
        if(gpu) {
          if(upload && job.inputBytes) memcpy(source.contents,job.input.data(),job.inputBytes);
          prepared=mach_absolute_time();
          auto command=[queue commandBuffer]; command.label=spec[@"algorithm"];
          auto encoder=[command computeCommandEncoder]; check(command && encoder,"Cannot create workload commands");
          [encoder setBuffer:source offset:0 atIndex:0]; [encoder setBuffer:arenaBuffer offset:0 atIndex:1];
          for(const auto& dispatch:plan.dispatches) {
            [encoder setComputePipelineState:pipelines[dispatch.kernel]];
            [encoder setBytes:&dispatch.params length:sizeof(dispatch.params) atIndex:2];
            [encoder dispatchThreadgroups:MTLSizeMake(dispatch.groups ? dispatch.groups : (dispatch.threads+255)/256,1,1)
              threadsPerThreadgroup:MTLSizeMake(256,1,1)];
            [encoder memoryBarrierWithScope:MTLBarrierScopeBuffers];
          }
          [encoder endEncoding]; encoded=mach_absolute_time();
          state.lease->submitted(command); [command commit]; [command waitUntilCompleted];
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
          const auto bytes=static_cast<const unsigned char*>(source.contents);
          for(size_t j=job.inputBytes;j<job.inputBytes+64;j++) check(bytes[j]==0xa5,"Input guard was modified");
        }
        if(round<warmups) continue;
        NSMutableDictionary* result=records[index];
        [result[@"samples"] addObject:@{@"elapsedUs":@(elapsed(start,consumed)),@"prepareUs":@(gpu ? elapsed(start,prepared) : 0),
          @"encodeUs":@(gpu ? elapsed(prepared,encoded) : 0),@"waitUs":@(gpu ? elapsed(encoded,computed) : 0),
          @"computeUs":@(gpu ? gpuUs : elapsed(start,computed)),@"gpuUs":@(gpuUs),@"consumeUs":@(elapsed(computed,consumed))}];
        result[@"resultCount"]=@(count); result[@"checksum"]=@(checksum); result[@"hostWaits"]=@(gpu ? 1 : 0);
        result[@"dispatches"]=@(gpu ? plan.dispatches.size() : 0); result[@"cpuTasks"]=@(gpu ? 0 : cpu.workers);
        if(job.kind==Workload::Merkle) result[@"digestHex"]=hex(output,32);
        if(includeOutput && round+1==warmups+samples) {
          NSMutableArray* data=[NSMutableArray new]; for(U32 j=0;j<count;j++) [data addObject:@(output[j])];
          result[@"output"]=data;
        }
      }
    }
    return records; // No GPU-backed pointer escapes; PreparedWorkload retains the lease.
  }
};
