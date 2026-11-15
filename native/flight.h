#pragma once
#import <dispatch/dispatch.h>
#include <atomic>
#include <functional>
#include <memory>

static constexpr U32 MaxInFlight=8;

struct Completion {
  dispatch_semaphore_t ready=dispatch_semaphore_create(0);
  std::atomic<uint64_t> tick{0};
};

// A future owns its buffers through GPU completion AND CPU consumption.
// The handler owns only notification state, never a raw Flight/Runtime pointer.
class Flight {
  std::shared_ptr<Completion> completion=std::make_shared<Completion>();
  bool committed=false,observed=false,consumed=false;
  std::unique_ptr<BufferLease> lease;
  id<MTLCommandBuffer> command;
  std::function<NSMutableDictionary*(uint64_t)> consume;
  void wait() {
    if(committed && !observed) {
      dispatch_semaphore_wait(completion->ready,DISPATCH_TIME_FOREVER);
      observed=true;
    }
  }
public:
  uint64_t started=0,submitted=0;
  U32 sequence=0,slot=0,resultIndex=0;
  bool fresh=false;

  Flight(std::unique_ptr<BufferLease> buffers,id<MTLCommandBuffer> commands,
      std::function<NSMutableDictionary*(uint64_t)> materialize)
    : lease(std::move(buffers)),command(commands),consume(std::move(materialize)) {}
  Flight(const Flight&)=delete;
  Flight& operator=(const Flight&)=delete;
  ~Flight() { wait(); }

  void commit() {
    check(!committed,"Flight was already submitted");
    auto state=completion;
    [command addCompletedHandler:^(id<MTLCommandBuffer>) {
      state->tick.store(mach_absolute_time(),std::memory_order_release);
      dispatch_semaphore_signal(state->ready);
    }];
    lease->submitted(command);
    submitted=mach_absolute_time();
    committed=true;
    [command commit];
  }
  size_t bytes() const { return lease->source.length+lease->arena.length; }
  NSMutableDictionary* finish(uint64_t batchStart) {
    check(committed && !consumed,"Flight must be submitted and consumed exactly once");
    uint64_t waiting=mach_absolute_time();
    wait(); // No host reads or waits between GPU passes.
    uint64_t finished=mach_absolute_time();
    check(command.status==MTLCommandBufferStatusCompleted,
      command.error ? command.error.localizedDescription.UTF8String : "GPU command did not complete");
    auto result=consume(finished);
    consumed=true;
    uint64_t consumed=mach_absolute_time();
    // Metal reports GPUStart/EndTime in host-clock seconds. Keep unavailable
    // timestamps null, rather than inventing overlap from a pending command.
    double batchHostUs=double(batchStart)*nsPerTick/1000.0;
    result[@"flight"]=@{@"sequence":@(sequence),@"slot":@(slot),
      @"gpuStartedUs":command.GPUStartTime>0 ? (id)@(command.GPUStartTime*1e6-batchHostUs) : (id)[NSNull null],
      @"gpuEndedUs":command.GPUEndTime>0 ? (id)@(command.GPUEndTime*1e6-batchHostUs) : (id)[NSNull null],
      @"prepareBeginUs":@(elapsed(batchStart,started)),@"submittedUs":@(elapsed(batchStart,submitted)),
      @"gpuCompletedUs":@(elapsed(batchStart,completion->tick.load(std::memory_order_acquire))),
      @"consumeBeginUs":@(elapsed(batchStart,finished)),@"consumeEndUs":@(elapsed(batchStart,consumed)),
      @"completionWaitUs":@(elapsed(waiting,finished))};
    return result;
  }
};
static_assert(!std::is_copy_constructible_v<Flight>);
