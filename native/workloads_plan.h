#pragma once

struct WorkloadDispatch { NSString* kernel; U32 threads,groups; WorkloadParams params; };
struct WorkloadPlan {
  static constexpr U32 Guard=16;
  U32 words=0,output=0,resultCount=0,countOffset=0;
  std::vector<std::pair<U32,U32>> spans;
  std::vector<WorkloadDispatch> dispatches;
  U32 take(U32 length) {
    U32 begin=words+Guard;
    words=begin+std::max(length,1u)+Guard;
    spans.push_back({begin,std::max(length,1u)}); return begin;
  }
  void add(NSString* name,U32 threads,WorkloadParams p,U32 groups=0) {
    dispatches.push_back({name,threads,groups,p});
  }
  explicit WorkloadPlan(const WorkloadJob& job) {
    U32 n=job.count;
    if(job.kind==Workload::Merkle) {
      U32 a=take(std::max(n,1u)*8),b=take(std::max((n+1)/2,1u)*8);
      output=a; resultCount=8;
      if(!n) add(@"sha_empty",1,{0,0,a,0,0,0,0,0});
      else {
        add(@"sha_leaves",n,{n,0,a,0,0,0,0,0});
        while(n>1) { add(@"sha_parents",(n+1)/2,{n,a,b,0,0,0,0,0}); std::swap(a,b); n=(n+1)/2; }
        output=a;
      }
    } else if(job.kind==Workload::Histogram) {
      U32 groups=std::min(std::max((n+4095)/4096,1u),1024u),partial=take(groups*256);
      output=take(256); resultCount=256;
      add(@"histogram_partials",groups*256,{n,0,partial,0,groups,0,0,0},groups);
      add(@"histogram_finish",256,{n,partial,output,0,groups,0,0,0});
    } else {
      output=take(n); U32 ranks=take(n),groups=std::max((n+255)/256,1u),sums=take(groups);
      add(@"compact_scan",std::max(n,1u),{n,0,ranks,sums,0,job.mask,0,0});
      struct Level { U32 length,offsets; };
      std::vector<Level> levels;
      U32 length=groups;
      while(true) {
        U32 offsets=take(length),blocks=(length+255)/256,next=take(blocks);
        add(@"scan_values",length,{length,sums,offsets,next,0,0,0,0});
        levels.push_back({length,offsets});
        if(blocks==1) { countOffset=next; break; }
        sums=next; length=blocks;
      }
      for(size_t k=levels.size()-1;k>0;k--) {
        auto child=levels[k-1];
        add(@"workload_scan_add",child.length,{child.length,0,child.offsets,levels[k].offsets,0,0,0,0});
      }
      add(@"compact_scatter",std::max(n,1u),{n,ranks,output,levels[0].offsets,0,job.mask,countOffset,0});
    }
  }
  void checkGuards(const U32* arena) const {
    for(const auto& [begin,length]:spans) for(U32 j=0;j<Guard;j++)
      check(arena[begin-Guard+j]==0xa5a5a5a5u && arena[begin+length+j]==0xa5a5a5a5u,"Arena logical guard was modified");
  }
};
