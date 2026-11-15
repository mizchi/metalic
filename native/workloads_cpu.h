#pragma once
#include <CommonCrypto/CommonDigest.h>
#include <array>

enum class Workload { Merkle, Histogram, Compact, Tea, Chase };
struct WorkloadJob {
  Workload kind;
  U32 count,seed,mask;
  bool hot;
  size_t inputBytes;
  std::vector<U32> input;
};
inline U32 nextRandom(U32& state) {
  state^=state<<13; state^=state>>17; state^=state<<5; return state;
}
inline U32 workerCount(U32 count,U32 grain,bool parallel,U32 threads) {
  return parallel ? std::min(threads*4,std::max((count+grain-1)/grain,1u)) : 1;
}
template<typename Body> void ranges(U32 count,U32 workers,Body body) {
  auto task=[&](U32 w) { body(U32(uint64_t(count)*w/workers),U32(uint64_t(count)*(w+1)/workers),w); };
  if(workers==1) task(0);
  else dispatch_apply(workers,dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^(size_t w) { task(U32(w)); });
}
struct alignas(64) HistogramScratch { U32 bins[4*256]; };
// TEA's 32 cycles with a fixed all-zero 128-bit key. CPU uses four blocks per
// NEON vector; the tail and independent test oracle also exercise scalar math.
template<typename Word> inline void tea32(Word& y,Word& z) {
  U32 sum=0;
  for(U32 round=0;round<32;round++) {
    sum+=0x9e3779b9u;
    y+=((z<<4)^(z+sum)^(z>>5)); z+=((y<<4)^(y+sum)^(y>>5));
  }
}
typedef U32 U32x4 __attribute__((ext_vector_type(4)));
struct CpuWorkload {
  std::vector<U32> output,a,b,counts,offsets;
  std::vector<HistogramScratch> hist;
  U32 resultCount=0,workers=1,threads;
  CpuWorkload(const WorkloadJob& job,U32 cores) : threads(cores) {
    output.resize(job.kind==Workload::Merkle ? 8 : job.kind==Workload::Histogram ? 256 :
      job.kind==Workload::Tea ? std::max(job.count*2,1u) : job.kind==Workload::Chase ? 2 : std::max(job.count,1u));
    if(job.kind==Workload::Merkle) { a.resize(size_t(std::max(job.count,1u))*8); b.resize(size_t(std::max((job.count+1)/2,1u))*8); }
    hist.resize(cores*4); counts.resize(cores*4); offsets.resize(cores*4);
  }
  void run(const WorkloadJob& job,bool parallel) {
    U32 n=job.count;
    const auto bytes=reinterpret_cast<const unsigned char*>(job.input.data());
    if(job.kind==Workload::Merkle) {
      workers=workerCount(n,512,parallel,threads);
      if(!n) { CC_SHA256(bytes,0,reinterpret_cast<unsigned char*>(output.data())); resultCount=8; return; }
      ranges(n,workers,[&](U32 begin,U32 end,U32) {
        for(U32 i=begin;i<end;i++) CC_SHA256(bytes+size_t(i)*64,64,reinterpret_cast<unsigned char*>(a.data()+size_t(i)*8));
      });
      U32* src=a.data(); U32* dst=b.data();
      while(n>1) {
        U32 parents=(n+1)/2;
        ranges(parents,workerCount(parents,512,parallel,threads),[&](U32 begin,U32 end,U32) {
          for(U32 i=begin;i<end;i++) {
            if(2*i+1<n) CC_SHA256(src+size_t(i)*16,64,reinterpret_cast<unsigned char*>(dst+size_t(i)*8));
            else {
              unsigned char pair[64]; memcpy(pair,src+size_t(i)*16,32); memcpy(pair+32,pair,32);
              CC_SHA256(pair,64,reinterpret_cast<unsigned char*>(dst+size_t(i)*8));
            }
          }
        });
        std::swap(src,dst); n=parents;
      }
      memcpy(output.data(),src,32); resultCount=8;
    } else if(job.kind==Workload::Histogram) {
      workers=workerCount(n,262144,parallel,threads);
      ranges(n,workers,[&](U32 begin,U32 end,U32 w) {
        U32* h=hist[w].bins; memset(h,0,sizeof(hist[w].bins));
        U32 i=begin;
        for(;end-i>=4;i+=4) { h[bytes[i]]++; h[256+bytes[i+1]]++; h[512+bytes[i+2]]++; h[768+bytes[i+3]]++; }
        for(;i<end;i++) h[bytes[i]]++;
      });
      for(U32 i=0;i<256;i++) {
        U32 sum=0; for(U32 w=0;w<workers;w++) for(U32 k=0;k<4;k++) sum+=hist[w].bins[k*256+i];
        output[i]=sum;
      }
      resultCount=256;
    } else if(job.kind==Workload::Tea) {
      workers=workerCount(n,4096,parallel,threads);
      ranges(n,workers,[&](U32 begin,U32 end,U32) {
        U32 i=begin;
        for(;end-i>=4;i+=4) {
          U32x4 y={job.input[2*i],job.input[2*i+2],job.input[2*i+4],job.input[2*i+6]};
          U32x4 z={job.input[2*i+1],job.input[2*i+3],job.input[2*i+5],job.input[2*i+7]};
          tea32(y,z);
          for(U32 lane=0;lane<4;lane++) { output[2*(i+lane)]=y[lane];output[2*(i+lane)+1]=z[lane]; }
        }
        for(;i<end;i++) { U32 y=job.input[2*i],z=job.input[2*i+1];tea32(y,z);output[2*i]=y;output[2*i+1]=z; }
      });
      resultCount=2*n;
    } else if(job.kind==Workload::Chase) {
      workers=1; U32 at=0,hash=2166136261u;
      for(U32 step=0;step<n;step++) { at=job.input[at];hash=(hash^at)*16777619u; }
      output[0]=at;output[1]=hash;resultCount=2;
    } else {
      workers=workerCount(n,65536,parallel,threads);
      if(workers==1) {
        // Always store into available capacity; only selected values advance.
        // This avoids a hard-to-predict branch for 50% selection.
        U32 out=0; for(U32 i=0;i<n;i++) { U32 value=job.input[i]; output[out]=value; out+=((value&job.mask)==0); }
        resultCount=out;
      } else {
        ranges(n,workers,[&](U32 begin,U32 end,U32 w) {
          U32 count=0; for(U32 i=begin;i<end;i++) count+=((job.input[i]&job.mask)==0); counts[w]=count;
        });
        U32 total=0; for(U32 w=0;w<workers;w++) { offsets[w]=total; total+=counts[w]; }
        ranges(n,workers,[&](U32 begin,U32 end,U32 w) {
          U32 out=offsets[w],stop=out+counts[w];
          for(U32 i=begin;i<end;i++) {
            U32 value=job.input[i];
            // The monotone guard prevents unselected tail stores from racing
            // with the next chunk, including chunks with zero selections.
            if(out<stop) output[out]=value;
            out+=((value&job.mask)==0);
          }
        });
        resultCount=total;
      }
    }
  }
};
inline U32 workloadChecksum(const U32* data,U32 count) {
  U32 sum=0; for(U32 i=0;i<count;i++) sum+=(data[i]^0x9e3779b9u)*(i+1); return sum;
}
