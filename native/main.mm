#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <mach/mach_time.h>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>
#include <optional>
#include "contract.h"
#include "passes.h"

static constexpr U32 NONE = 0xffffffffu;
#include "buffers.h"
#include "arena.h"
static_assert(sizeof(Layout)==172 && sizeof(Params)==216,"Unexpected host/Metal scalar ABI layout");
static_assert((uint64_t(MaxSourceBytes)<<DiagnosticCodeBits)+((1u<<DiagnosticCodeBits)-1)<NONE);
static double nsPerTick;
static double elapsed(uint64_t a, uint64_t b) { return (b-a)*nsPerTick/1000.0; }
static void check(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}
static U32 powerOfTwo(U32 n) { U32 v=1; while(v<n) v*=2; return v; }
static id nullable(U32 n) { return n==NONE ? (id)[NSNull null] : (id)@(n); }
static NSString* strategyName(DiagnosticStrategy strategy) {
  return strategy==DTree ? @"tree" : strategy==DHierarchical ? @"hierarchical" : @"packed";
}
static DiagnosticStrategy parseStrategy(id value) {
  check(!value || [value isEqual:@"tree"] || [value isEqual:@"hierarchical"] || [value isEqual:@"packed"],
    "Unknown diagnostic strategy");
  return !value || [value isEqual:@"packed"] ? DPacked : [value isEqual:@"hierarchical"] ? DHierarchical : DTree;
}

static NSString* bufferName(BufferStrategy buffers) {
  return buffers==BufferStrategy::Fresh ? @"fresh" : buffers==BufferStrategy::Reuse ? @"reuse" : @"selective";
}
static BufferStrategy parseBuffers(id value) {
  check(!value || [value isEqual:@"fresh"] || [value isEqual:@"reuse"] || [value isEqual:@"selective"],
    "Unknown buffer strategy");
  return [value isEqual:@"selective"] ? BufferStrategy::Selective : [value isEqual:@"reuse"] ? BufferStrategy::Reuse : BufferStrategy::Fresh;
}
struct Configuration { DiagnosticStrategy diagnostics; BufferStrategy buffers; };

// Normal tracked command buffers retain their resources. This object and every
// allocation also stay alive until the ONLY host completion wait has returned.
class Runtime {
  id<MTLDevice> device;
  id<MTLCommandQueue> queue;
  NSMutableDictionary<NSString*, id<MTLComputePipelineState>>* pipelines;
  BufferPool pools[2];
public:
  double setupUs=0;
  Runtime(NSString* directory) {
    uint64_t start=mach_absolute_time();
    device=MTLCreateSystemDefaultDevice();
    check(device!=nil && device.hasUnifiedMemory,"A unified-memory Metal GPU is required");
    queue=[device newCommandQueue];
    NSError* error=nil;
    NSString* header=[NSString stringWithContentsOfFile:[directory stringByAppendingPathComponent:@"contract.h"]
      encoding:NSUTF8StringEncoding error:&error];
    check(header!=nil,"Cannot read ABI header");
    NSString* body=[NSString stringWithContentsOfFile:[directory stringByAppendingPathComponent:@"frontend.metal"]
      encoding:NSUTF8StringEncoding error:&error];
    check(body!=nil,"Cannot read Metal source");
    NSString* source=[@"#include <metal_stdlib>\nusing namespace metal;\n" stringByAppendingString:header];
    source=[source stringByAppendingString:body];
    NSString* module=[NSString stringWithContentsOfFile:[directory stringByAppendingPathComponent:@"module.metal"]
      encoding:NSUTF8StringEncoding error:&error];
    check(module!=nil,"Cannot read module kernels");
    source=[source stringByAppendingString:module];
    MTLCompileOptions* options=[MTLCompileOptions new];
    options.languageVersion=MTLLanguageVersion4_0;
    id<MTLLibrary> library=[device newLibraryWithSource:source options:options error:&error];
    check(library!=nil, error ? error.localizedDescription.UTF8String : "Metal library compilation failed");
    pipelines=[NSMutableDictionary new];
    for (NSString* name in @[@"lex_summarize",@"lex_compose",@"lex_mark",@"scan_blocks",@"scan_add",
        @"tokenize",@"paren_deltas",@"validate_structure",@"normalize_operators",@"scatter_nodes",
        @"rmq_seed",@"rmq_level",@"build_ast",@"validate_ast",@"error_seed",@"error_level",@"error_publish",
        @"error_reduce",@"error_publish_min",@"error_publish_packed",
        @"mark_functions",@"index_functions",@"parse_function_headers",@"classify_function_tokens",
        @"validate_function_bodies",@"resolve_declarations",@"resolve_names",@"seed_types",@"check_types",@"check_returns"]) {
      id<MTLComputePipelineState> pso=[device newComputePipelineStateWithFunction:[library newFunctionWithName:name] error:&error];
      check(pso!=nil,error ? error.localizedDescription.UTF8String : "Missing kernel");
      check(pso.maxTotalThreadsPerThreadgroup>=256,"Kernel cannot support the scan group size");
      pipelines[name]=pso;
    }
    setupUs=elapsed(start,mach_absolute_time());
  }
  NSString* name() { return device.name; }

  NSDictionary* run(NSString* input,U32 chunk,bool materialize,bool moduleMode,DiagnosticStrategy diagnostics,
      BufferStrategy buffers,bool poisonBuffers) {
    uint64_t start=mach_absolute_time();
    NSData* bytes=[input dataUsingEncoding:NSUTF8StringEncoding];
    check(bytes!=nil,"Source cannot be encoded as UTF-8");
    check(bytes.length<=MaxSourceBytes,"Prototype input limit is 1 MiB of UTF-8 bytes");
    U32 n=U32(bytes.length), cap=std::max(n,1u);
    U32 chunks=std::max((n+chunk-1)/chunk,1u), treeBase=powerOfTwo(n+1);
    ArenaPlan plan;
    Layout l{};
#define COLUMN(field) l.field=plan.take(cap)
    COLUMN(starts); COLUMN(ends); COLUMN(ranks); COLUMN(tokKind); COLUMN(tokBegin); COLUMN(tokEnd);
    COLUMN(delta); COLUMN(depth); COLUMN(nodeFlags); COLUMN(nodeRanks); COLUMN(tokenNode); COLUMN(nodeToken);
    COLUMN(nodeKind); COLUMN(nodeDepth); COLUMN(nodeValue); COLUMN(nodeBegin); COLUMN(nodeEnd);
    COLUMN(left); COLUMN(right); COLUMN(parent);
    if(moduleMode) {
      COLUMN(fnFlags); COLUMN(fnRanks); COLUMN(closeInput); COLUMN(closeRanks); COLUMN(active);
      COLUMN(paramType); COLUMN(nodeOwner); COLUMN(nodeBinding); COLUMN(nodeType);
#define FUNCTION_COLUMN(field) l.field=plan.take(MaxFunctions)
      FUNCTION_COLUMN(fnToken); FUNCTION_COLUMN(fnName); FUNCTION_COLUMN(fnParamCount); FUNCTION_COLUMN(fnReturnType);
      FUNCTION_COLUMN(fnBodyBegin); FUNCTION_COLUMN(fnBodyEnd); FUNCTION_COLUMN(fnRoot); FUNCTION_COLUMN(fnValid);
#undef FUNCTION_COLUMN
      l.fnParams=plan.take(MaxFunctions*MaxParameters);
    }
#undef COLUMN
    l.tree=plan.take(2*treeBase); l.errors=plan.take(diagnostics==DPacked ? 0 : n+1); l.control=plan.take(CCount);
    l.maps0=plan.take(chunks*SCount); l.maps1=plan.take(chunks*SCount);
    U32 total=plan.next+4*cap+1024; plan.limit=total;
    uint64_t planned=mach_absolute_time();
    BufferPool* pool=buffers==BufferStrategy::Fresh ? nullptr : &pools[buffers==BufferStrategy::Reuse ? 0 : 1];
    BufferLease lease=acquireBuffers(device,pool,cap,size_t(total)*4);
    id<MTLBuffer> source=lease.source,arena=lease.arena;
    uint64_t acquired=mach_absolute_time();
    size_t poisonedBytes=0;
    if(poisonBuffers) {
      memset(source.contents,0xa5,source.length); memset(arena.contents,0xa5,arena.length);
      poisonedBytes=source.length+arena.length;
    }
    if(n) memcpy(source.contents,bytes.bytes,n);
    auto memory=(U32*)arena.contents;
    size_t initializedBytes=initializeArena(memory,l,n,cap,total,moduleMode,diagnostics,buffers==BufferStrategy::Selective);
    uint64_t initialized=mach_absolute_time();

    id<MTLCommandBuffer> command=[queue commandBuffer];
    id<MTLComputeCommandEncoder> encoder=[command computeCommandEncoder];
    [encoder setBuffer:source offset:0 atIndex:0];
    [encoder setBuffer:arena offset:0 atIndex:1];
    U32 dispatches=0, diagnosticDispatches=0;
    Params base{l,n,cap,0,0,0,0,0,chunk,U32(moduleMode),U32(diagnostics),0};
    auto dispatch=[&](NSString* kernel,U32 size,Params p,U32 groups=0) {
      p.size=size;
      [encoder setComputePipelineState:pipelines[kernel]];
      [encoder setBytes:&p length:sizeof(p) atIndex:2];
      [encoder dispatchThreadgroups:MTLSizeMake(groups ? groups : (size+255)/256,1,1)
          threadsPerThreadgroup:MTLSizeMake(256,1,1)];
      [encoder memoryBarrierWithScope:MTLBarrierScopeBuffers];
      dispatches++;
    };
    auto scan=[&](auto&& self,U32 in,U32 out,U32 length,U32 minimum=0)->void {
      U32 groups=(length+255)/256, totals=plan.take(groups);
      Params p=base; p.a=in; p.b=out; p.c=totals; p.d=minimum;
      dispatch(@"scan_blocks",length,p);
      if(groups>1) {
        U32 offsets=plan.take(groups);
        self(self,totals,offsets,groups,minimum);
        p=base; p.a=out; p.b=offsets; p.d=minimum;
        dispatch(@"scan_add",length,p);
      }
    };
    auto diagnose=[&]() {
      U32 before=dispatches;
      if(diagnostics==DPacked) {
        dispatch(@"error_publish_packed",1,base);
      } else if(diagnostics==DHierarchical) {
        U32 groups=std::min((n+1+255)/256,256u);
        Params p=base; p.a=l.errors; p.b=l.tree; p.c=1; p.step=groups*256;
        dispatch(@"error_reduce",n+1,p,groups);
        U32 key=l.tree;
        if(groups>1) {
          key=l.tree+groups;
          p=base; p.a=l.tree; p.b=key; p.step=256;
          dispatch(@"error_reduce",groups,p);
        }
        p=base; p.a=key; dispatch(@"error_publish_min",1,p);
      } else {
        Params p=base; p.a=treeBase;
        dispatch(@"error_seed",treeBase,p);
        for(U32 level=treeBase/2;level;level/=2) {
          p=base; p.a=level; dispatch(@"error_level",level,p);
        }
        dispatch(@"error_publish",1,base);
      }
      diagnosticDispatches+=dispatches-before;
    };
    // Logical nanopasses; physical scan/reduction dispatches are internal.
    NSArray* names=@[@"Lex",@"Tokenize",@"Structure",@"NormalizeOperators",@"BuildAst",@"ValidateAst"];
    if(moduleMode) names=[names arrayByAddingObjectsFromArray:@[@"ResolveNames",@"CheckTypes"]];
    auto lexed=advance(beginPipeline(),[&] {
      Params p=base; p.a=l.maps0; dispatch(@"lex_summarize",chunks,p);
      U32 maps=l.maps0, other=l.maps1;
      for(U32 stride=1;stride<chunks;stride*=2) {
        p=base; p.a=maps; p.b=other; p.step=stride;
        dispatch(@"lex_compose",chunks,p); std::swap(maps,other);
      }
      p=base; p.a=maps; dispatch(@"lex_mark",chunks,p);
    });
    auto tokenized=advance(std::move(lexed),[&] {
      scan(scan,l.starts,l.ranks,cap);
      dispatch(@"tokenize",cap,base);
    });
    auto structured=advance(std::move(tokenized),[&] {
      if(moduleMode) {
        dispatch(@"mark_functions",cap,base);
        scan(scan,l.fnFlags,l.fnRanks,cap);
        scan(scan,l.closeInput,l.closeRanks,cap,1);
        dispatch(@"index_functions",cap,base);
        Params p=base; p.a=cap;
        dispatch(@"parse_function_headers",MaxFunctions,p);
        dispatch(@"classify_function_tokens",cap,base);
      }
      dispatch(@"paren_deltas",cap,base);
      scan(scan,l.delta,l.depth,cap);
      dispatch(@"validate_structure",cap,base);
      if(moduleMode) dispatch(@"validate_function_bodies",MaxFunctions,base);
    });
    auto operators=advance(std::move(structured),[&] {
      dispatch(@"normalize_operators",cap,base);
      scan(scan,l.nodeFlags,l.nodeRanks,cap);
      dispatch(@"scatter_nodes",cap,base);
      diagnose();
    });
    auto ast=advance(std::move(operators),[&] {
      Params p=base; p.a=treeBase; dispatch(@"rmq_seed",treeBase,p);
      for(U32 level=treeBase/2;level;level/=2) {
        p=base; p.a=level; dispatch(@"rmq_level",level,p);
      }
      p=base; p.a=treeBase; dispatch(@"build_ast",cap,p);
    });
    auto checked=advance(std::move(ast),[&] {
      dispatch(@"validate_ast",cap,base);
      diagnose();
    });
    std::optional<Scheduled<Phase::TypedAst>> typed;
    if(moduleMode) {
      auto resolved=advance(std::move(checked),[&] {
        base.errorPhase=1;
        dispatch(@"resolve_declarations",MaxFunctions,base);
        dispatch(@"resolve_names",cap,base);
        diagnose();
      });
      typed.emplace(advance(std::move(resolved),[&] {
        base.errorPhase=2;
        dispatch(@"seed_types",cap,base);
        dispatch(@"check_types",cap,base);
        dispatch(@"check_returns",MaxFunctions,base);
        diagnose();
      }));
    }
    [encoder endEncoding];
    uint64_t encoded=mach_absolute_time();
    [command commit]; lease.submitted(command);
    U32 hostWaits=0;
    [command waitUntilCompleted]; // No host reads or waits occur between passes.
    hostWaits++;
    if(moduleMode) typed->consume(); else checked.consume();
    uint64_t finished=mach_absolute_time();
    check(command.status==MTLCommandBufferStatusCompleted,
      command.error ? command.error.localizedDescription.UTF8String : "GPU command did not complete");
    U32 tokenCount=memory[l.control+CTokenCount], nodeCount=memory[l.control+CNodeCount];
    check(tokenCount<=cap && nodeCount<=tokenCount,"GPU count exceeded arena capacity");
    U32 errorCode=memory[l.control+CErrorCode], root=memory[l.control+CRoot];
    U32 functionCount=moduleMode ? memory[l.control+CFunctionCount] : 0;
    check(errorCode || (moduleMode ? functionCount>0 && functionCount<=MaxFunctions : root<nodeCount),"AST root missing");
    NSMutableDictionary* result=[@{@"backend":@"metal",@"device":device.name,@"passes":names,
      @"dispatches":@(dispatches),@"hostWaits":@(hostWaits),@"chunkSize":@(chunk),
      @"diagnostics":strategyName(diagnostics),@"diagnosticDispatches":@(diagnosticDispatches),
      @"mslVersion":[NSString stringWithFormat:@"%u.%u",memory[l.control+CMetalVersion]/100,(memory[l.control+CMetalVersion]%100)/10],
      @"buffers":bufferName(buffers),@"bufferAllocations":@(lease.allocations),
      @"initializedBytes":@(initializedBytes),@"poisonedBytes":@(poisonedBytes),
      @"sourceCapacityBytes":@(source.length),@"arenaCapacityBytes":@(arena.length),
      @"elapsedUs":@(elapsed(start,finished)),
      @"gpuUs":@((command.GPUEndTime-command.GPUStartTime)*1e6),
      @"arenaBytes":@(size_t(total)*4)} mutableCopy];
    if(materialize) {
      NSMutableArray* tokens=[NSMutableArray new];
      for(U32 j=0;j<tokenCount;j++) [tokens addObject:@{@"kind":@(memory[l.tokKind+j]),
        @"begin":@(memory[l.tokBegin+j]),@"end":@(memory[l.tokEnd+j])}];
      NSMutableArray* nodes=[NSMutableArray new];
      if(!errorCode) for(U32 j=0;j<nodeCount;j++) {
        NSMutableDictionary* node=[@{
        @"kind":@(memory[l.nodeKind+j]),@"begin":@(memory[l.nodeBegin+j]),@"end":@(memory[l.nodeEnd+j]),
        @"value":@(memory[l.nodeValue+j]),@"left":nullable(memory[l.left+j]),@"right":nullable(memory[l.right+j])} mutableCopy];
        if(moduleMode) {
          node[@"functionId"]=@(memory[l.nodeOwner+j]); node[@"binding"]=nullable(memory[l.nodeBinding+j]);
          node[@"type"]=@(memory[l.nodeType+j]);
        }
        [nodes addObject:node];
      }
      if(moduleMode) {
        NSMutableArray* functions=[NSMutableArray new];
        if(!errorCode) for(U32 f=0;f<functionCount;f++) {
          U32 name=memory[l.fnName+f];
          NSMutableArray* parameters=[NSMutableArray new];
          for(U32 j=0;j<memory[l.fnParamCount+f];j++) {
            U32 token=memory[l.fnParams+f*MaxParameters+j];
            [parameters addObject:@{@"binding":@(token),@"begin":@(memory[l.tokBegin+token]),
              @"end":@(memory[l.tokEnd+token]),@"type":@(memory[l.paramType+token])}];
          }
          [functions addObject:@{@"begin":@(memory[l.tokBegin+name]),@"end":@(memory[l.tokEnd+name]),
            @"parameters":parameters,@"returnType":@(memory[l.fnReturnType+f]),@"body":@(memory[l.fnRoot+f])}];
        }
        result[@"functions"]=functions;
      }
      result[@"tokens"]=tokens; result[@"nodes"]=nodes;
      result[@"root"]=errorCode || moduleMode ? (id)[NSNull null] : nullable(root);
      result[@"diagnostic"]=errorCode ? (id)@{@"code":@(errorCode),@"offset":@(memory[l.control+CErrorOffset])} : (id)[NSNull null];
    }
    uint64_t materialized=mach_absolute_time();
    result[@"timingsUs"]=@{@"prepareUs":@(elapsed(start,planned)),@"acquireUs":@(elapsed(planned,acquired)),
      @"initializeUs":@(elapsed(acquired,initialized)),@"encodeUs":@(elapsed(initialized,encoded)),
      @"submitWaitUs":@(elapsed(encoded,finished)),@"materializeUs":@(elapsed(finished,materialized))};
    return result;
  }
};

int main(int argc,const char** argv) {
  @autoreleasepool {
    try {
      check(argc==2,"usage: frontend-metal <native-source-directory>; JSON request on stdin");
      mach_timebase_info_data_t t; mach_timebase_info(&t); nsPerTick=double(t.numer)/t.denom;
      NSData* data=[[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
      NSError* error=nil;
      NSDictionary* request=[NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
      check([request isKindOfClass:[NSDictionary class]],"Expected JSON object");
      NSArray* sources=request[@"sources"];
      check([sources isKindOfClass:[NSArray class]] && sources.count<=4096,"Expected at most 4096 sources");
      U32 chunk=request[@"chunkSize"] ? [request[@"chunkSize"] unsignedIntValue] : 64;
      U32 repeat=request[@"repeat"] ? [request[@"repeat"] unsignedIntValue] : 1;
      check(chunk>=1 && chunk<=1024 && repeat>=1 && repeat<=1000,"Invalid chunkSize or repeat");
      id language=request[@"language"];
      check(!language || [language isEqual:@"expression"] || [language isEqual:@"module"],"Invalid language mode");
      bool moduleMode=[language isEqual:@"module"];
      id requested=request[@"diagnostics"];
      NSArray* strategies=[requested isKindOfClass:[NSArray class]] ? requested : @[requested ?: @"packed"];
      check(strategies.count>0 && strategies.count<=3,"Expected one to three diagnostic strategies");
      check([NSSet setWithArray:strategies].count==strategies.count,"Diagnostic strategies must be distinct");
      for(id value in strategies) parseStrategy(value);
      id requestedBuffers=request[@"buffers"];
      NSArray* bufferStrategies=[requestedBuffers isKindOfClass:[NSArray class]] ? requestedBuffers : @[requestedBuffers ?: @"fresh"];
      check(bufferStrategies.count>0 && bufferStrategies.count<=3,"Expected one to three buffer strategies");
      check([NSSet setWithArray:bufferStrategies].count==bufferStrategies.count,"Buffer strategies must be distinct");
      std::vector<Configuration> configurations;
      for(id value in strategies) for(id storage in bufferStrategies)
        configurations.push_back({parseStrategy(value),parseBuffers(storage)});
      id poison=request[@"poisonBuffers"];
      check(!poison || CFGetTypeID((__bridge CFTypeRef)poison)==CFBooleanGetTypeID(),"poisonBuffers must be a boolean");
      bool poisonBuffers=[poison boolValue];
      Runtime runtime(@(argv[1]));
      NSMutableArray* results=[NSMutableArray new];
      for(id source in sources) {
        check([source isKindOfClass:[NSString class]],"Source must be a string");
        NSMutableArray* samples=[NSMutableArray new];
        NSMutableArray* gpuSamples=[NSMutableArray new];
        NSMutableArray* last=[NSMutableArray new];
        NSMutableArray* timings=[NSMutableArray new];
        NSMutableArray* allocations=[NSMutableArray new];
        for(U32 i=0;i<configurations.size();i++) {
          [samples addObject:[NSMutableArray new]]; [gpuSamples addObject:[NSMutableArray new]];
          [timings addObject:[NSMutableArray new]]; [allocations addObject:[NSMutableArray new]];
          [last addObject:[NSNull null]];
        }
        for(U32 run=0;run<repeat;run++) {
          // Rotate order each round, comparing schedules with the same device,
          // library and process rather than timing separate process lifetimes.
          for(U32 slot=0;slot<configurations.size();slot++) {
            U32 index=(slot+run)%U32(configurations.size());
            @autoreleasepool {
              auto config=configurations[index];
              NSDictionary* current=runtime.run(source,chunk,run+1==repeat,moduleMode,config.diagnostics,config.buffers,poisonBuffers);
              last[index]=current;
              [samples[index] addObject:current[@"elapsedUs"]]; [gpuSamples[index] addObject:current[@"gpuUs"]];
              [timings[index] addObject:current[@"timingsUs"]]; [allocations[index] addObject:current[@"bufferAllocations"]];
            }
          }
        }
        for(U32 i=0;i<configurations.size();i++) {
          NSMutableDictionary* result=[last[i] mutableCopy];
          result[@"samplesUs"]=samples[i]; result[@"gpuSamplesUs"]=gpuSamples[i];
          result[@"timingSamplesUs"]=timings[i]; result[@"allocationSamples"]=allocations[i];
          result[@"setupUs"]=@(runtime.setupUs);
          [results addObject:result];
        }
      }
      NSData* output=[NSJSONSerialization dataWithJSONObject:results options:0 error:&error];
      check(output!=nil,"Cannot serialize results");
      fwrite(output.bytes,1,output.length,stdout); fputc('\n',stdout);
    } catch(const std::exception& error) {
      fprintf(stderr,"metal-nanopass: %s\n",error.what()); return 1;
    }
  }
}
