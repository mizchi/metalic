#pragma once
#include <stdexcept>
#include <type_traits>

enum class BufferStrategy { Fresh, Reuse, Selective };
class BufferPool;
class BufferLease;
inline BufferLease acquireBuffers(id<MTLDevice>,BufferPool*,size_t,size_t);

// A lease covers submission AND host result materialization. A failed run also
// waits for an already committed command before returning its slot to the pool.
class BufferLease {
  BufferPool* owner;
  id<MTLCommandBuffer> submission=nil;
  BufferLease(BufferPool* pool,id<MTLBuffer> s,id<MTLBuffer> a,U32 count)
    : owner(pool),source(s),arena(a),allocations(count) {}
  friend BufferLease acquireBuffers(id<MTLDevice>,BufferPool*,size_t,size_t);
public:
  id<MTLBuffer> source,arena;
  U32 allocations;
  BufferLease(const BufferLease&)=delete;
  BufferLease& operator=(const BufferLease&)=delete;
  BufferLease(BufferLease&&)=delete;
  ~BufferLease();
  void submitted(id<MTLCommandBuffer> command) { submission=command; }
};

// The current driver is synchronous and allows one lease per pool. A future
// asynchronous driver must use multiple slots, not overwrite this active one.
class BufferPool {
  id<MTLBuffer> source=nil,arena=nil;
  bool borrowed=false;
  friend class BufferLease;
  friend BufferLease acquireBuffers(id<MTLDevice>,BufferPool*,size_t,size_t);
public:
  BufferPool()=default;
  BufferPool(const BufferPool&)=delete;
  BufferPool& operator=(const BufferPool&)=delete;
  BufferPool(BufferPool&&)=delete;
};

inline BufferLease::~BufferLease() {
  if(submission && submission.status!=MTLCommandBufferStatusCompleted &&
      submission.status!=MTLCommandBufferStatusError) [submission waitUntilCompleted];
  if(owner) owner->borrowed=false;
}

inline size_t bufferCapacity(size_t requested) {
  size_t capacity=4096;
  while(capacity<requested) capacity*=2;
  return capacity;
}

inline BufferLease acquireBuffers(id<MTLDevice> device,BufferPool* pool,size_t sourceBytes,size_t arenaBytes) {
  if(pool && pool->borrowed) throw std::logic_error("Buffer pool already has an active lease");
  id<MTLBuffer> source=pool ? pool->source : nil,arena=pool ? pool->arena : nil;
  U32 allocations=0;
  if(!source || source.length<sourceBytes) {
    source=[device newBufferWithLength:pool ? bufferCapacity(sourceBytes) : sourceBytes options:MTLResourceStorageModeShared];
    allocations++;
  }
  if(!arena || arena.length<arenaBytes) {
    arena=[device newBufferWithLength:pool ? bufferCapacity(arenaBytes) : arenaBytes options:MTLResourceStorageModeShared];
    allocations++;
  }
  if(!source || !arena) throw std::runtime_error("Metal buffer allocation failed");
  if(pool) { pool->source=source; pool->arena=arena; pool->borrowed=true; }
  return BufferLease(pool,source,arena,allocations);
}
static_assert(!std::is_copy_constructible_v<BufferLease>);
static_assert(!std::is_copy_constructible_v<BufferPool>);
