// Integer workloads. Cooperative kernels always dispatch uniform groups of 256.
#if __METAL_VERSION__ != 400
#error Workload experiments require MSL 4.0
#endif
constant uint WL_K[64]={
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
inline uint wl_rotr(uint x,uint n) { return (x>>n)|(x<<(32-n)); }
inline uint wl_swap(uint x) { return ((x&255)<<24)|((x&0xff00)<<8)|((x>>8)&0xff00)|(x>>24); }
inline void wl_init(thread uint* s) {
  s[0]=0x6a09e667; s[1]=0xbb67ae85; s[2]=0x3c6ef372; s[3]=0xa54ff53a;
  s[4]=0x510e527f; s[5]=0x9b05688c; s[6]=0x1f83d9ab; s[7]=0x5be0cd19;
}
inline void wl_compress(thread uint* s,thread uint* w) {
  uint a=s[0],b=s[1],c=s[2],d=s[3],e=s[4],f=s[5],g=s[6],h=s[7];
#pragma unroll
  for(uint t=0;t<64;t++) {
    if(t>=16) {
      uint x=w[(t-15)&15],y=w[(t-2)&15];
      w[t&15]+=(wl_rotr(x,7)^wl_rotr(x,18)^(x>>3))+w[(t-7)&15]+(wl_rotr(y,17)^wl_rotr(y,19)^(y>>10));
    }
    uint t1=h+(wl_rotr(e,6)^wl_rotr(e,11)^wl_rotr(e,25))+((e&f)^((~e)&g))+WL_K[t]+w[t&15];
    uint t2=(wl_rotr(a,2)^wl_rotr(a,13)^wl_rotr(a,22))+((a&b)^(a&c)^(b&c));
    h=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
  }
  s[0]+=a; s[1]+=b; s[2]+=c; s[3]+=d; s[4]+=e; s[5]+=f; s[6]+=g; s[7]+=h;
}
inline void wl_pad64(thread uint* s,thread uint* w) {
  for(uint j=0;j<16;j++) w[j]=0;
  w[0]=0x80000000; w[15]=512; wl_compress(s,w);
}
kernel void sha_leaves(device const uint* input [[buffer(0)]],device uint* arena [[buffer(1)]],
    constant WorkloadParams& p [[buffer(2)]],uint i [[thread_position_in_grid]]) {
  if(i>=p.n) return;
  uint s[8],w[16]; wl_init(s);
  for(uint j=0;j<16;j++) w[j]=wl_swap(input[i*16+j]);
  wl_compress(s,w); wl_pad64(s,w);
  for(uint j=0;j<8;j++) arena[p.outputOffset+i*8+j]=wl_swap(s[j]);
}
kernel void sha_parents(device const uint* input [[buffer(0)]],device uint* arena [[buffer(1)]],
    constant WorkloadParams& p [[buffer(2)]],uint i [[thread_position_in_grid]]) {
  (void)input;
  if(i>=(p.n+1)/2) return;
  uint s[8],w[16]; wl_init(s);
  uint left=2*i,right=min(left+1,p.n-1);
  for(uint j=0;j<8;j++) { w[j]=wl_swap(arena[p.inputOffset+left*8+j]); w[j+8]=wl_swap(arena[p.inputOffset+right*8+j]); }
  wl_compress(s,w); wl_pad64(s,w);
  for(uint j=0;j<8;j++) arena[p.outputOffset+i*8+j]=wl_swap(s[j]);
}
kernel void sha_empty(device const uint* input [[buffer(0)]],device uint* arena [[buffer(1)]],
    constant WorkloadParams& p [[buffer(2)]],uint i [[thread_position_in_grid]]) {
  (void)input;
  if(i) return;
  uint s[8],w[16]; wl_init(s);
  for(uint j=0;j<16;j++) w[j]=0;
  w[0]=0x80000000; wl_compress(s,w);
  for(uint j=0;j<8;j++) arena[p.outputOffset+j]=wl_swap(s[j]);
}

kernel void histogram_partials(device const uchar* input [[buffer(0)]],device uint* arena [[buffer(1)]],
    constant WorkloadParams& p [[buffer(2)]],uint t [[thread_index_in_threadgroup]],
    uint group [[threadgroup_position_in_grid]],uint sid [[simdgroup_index_in_threadgroup]],
    uint lane [[thread_index_in_simdgroup]]) {
  threadgroup atomic_uint bins[8*256];
  for(uint j=t;j<8*256;j+=256) atomic_store_explicit(bins+j,0,memory_order_relaxed);
  threadgroup_barrier(mem_flags::mem_threadgroup);
  for(uint base=group*256;base<p.n;base+=p.groups*256) {
    uint i=base+t,value=i<p.n ? uint(input[i]) : 256;
    uint low=simd_min(value),high=simd_max(value);
    if(low==high) {
      uint amount=simd_sum(uint(i<p.n));
      if(lane==0 && low<256) atomic_fetch_add_explicit(bins+sid*256+low,amount,memory_order_relaxed);
    } else if(i<p.n) atomic_fetch_add_explicit(bins+sid*256+value,1,memory_order_relaxed);
  }
  threadgroup_barrier(mem_flags::mem_threadgroup);
  uint sum=0; for(uint j=0;j<8;j++) sum+=atomic_load_explicit(bins+j*256+t,memory_order_relaxed);
  arena[p.outputOffset+group*256+t]=sum;
}
kernel void histogram_finish(device const uint* input [[buffer(0)]],device uint* arena [[buffer(1)]],
    constant WorkloadParams& p [[buffer(2)]],uint i [[thread_position_in_grid]]) {
  (void)input;
  if(i>=256) return;
  uint sum=0; for(uint j=0;j<p.groups;j++) sum+=arena[p.inputOffset+j*256+i];
  arena[p.outputOffset+i]=sum;
}

// The runtime explicitly checks SIMD width 32 and group capacity 256.
inline uint wl_group_scan(uint value,threadgroup uint* scratch,uint lane,uint sid) {
  uint rank=simd_prefix_exclusive_sum(value),total=simd_sum(value);
  if(lane==0) scratch[sid]=total;
  threadgroup_barrier(mem_flags::mem_threadgroup);
  if(sid==0) {
    uint x=lane<8 ? scratch[lane] : 0;
    uint prefix=simd_prefix_exclusive_sum(x);
    if(lane<8) scratch[8+lane]=prefix;
    if(lane==7) scratch[16]=prefix+x;
  }
  threadgroup_barrier(mem_flags::mem_threadgroup);
  return rank+scratch[8+sid];
}
kernel void compact_scan(device const uint* input [[buffer(0)]],device uint* arena [[buffer(1)]],
    constant WorkloadParams& p [[buffer(2)]],uint i [[thread_position_in_grid]],
    uint t [[thread_index_in_threadgroup]],uint group [[threadgroup_position_in_grid]],
    uint lane [[thread_index_in_simdgroup]],uint sid [[simdgroup_index_in_threadgroup]]) {
  threadgroup uint scratch[17];
  uint value=i<p.n ? uint((input[i]&p.mask)==0) : 0;
  uint rank=wl_group_scan(value,scratch,lane,sid);
  if(i<p.n) arena[p.outputOffset+i]=rank;
  if(t==0) arena[p.auxOffset+group]=scratch[16];
}
kernel void scan_values(device const uint* input [[buffer(0)]],device uint* arena [[buffer(1)]],
    constant WorkloadParams& p [[buffer(2)]],uint i [[thread_position_in_grid]],
    uint t [[thread_index_in_threadgroup]],uint group [[threadgroup_position_in_grid]],
    uint lane [[thread_index_in_simdgroup]],uint sid [[simdgroup_index_in_threadgroup]]) {
  (void)input;
  threadgroup uint scratch[17];
  uint value=i<p.n ? arena[p.inputOffset+i] : 0;
  uint rank=wl_group_scan(value,scratch,lane,sid);
  if(i<p.n) arena[p.outputOffset+i]=rank;
  if(t==0) arena[p.auxOffset+group]=scratch[16];
}
kernel void workload_scan_add(device const uint* input [[buffer(0)]],device uint* arena [[buffer(1)]],
    constant WorkloadParams& p [[buffer(2)]],uint i [[thread_position_in_grid]]) {
  (void)input;
  if(i<p.n) arena[p.outputOffset+i]+=arena[p.auxOffset+i/256];
}
kernel void compact_scatter(device const uint* input [[buffer(0)]],device uint* arena [[buffer(1)]],
    constant WorkloadParams& p [[buffer(2)]],uint i [[thread_position_in_grid]]) {
  if(i<p.n && (input[i]&p.mask)==0)
    arena[p.outputOffset+arena[p.inputOffset+i]+arena[p.auxOffset+i/256]]=input[i];
}
