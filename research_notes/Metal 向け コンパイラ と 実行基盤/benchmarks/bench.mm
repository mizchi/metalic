#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <mach/mach_time.h>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>

static double ns_per_tick;
static volatile uint64_t sink;

static uint64_t tick() { return mach_absolute_time(); }
static double us(uint64_t a, uint64_t b) {
  return double(b - a) * ns_per_tick / 1000.0;
}
static void require(bool ok, const char* message) {
  if (!ok) { fprintf(stderr, "%s\n", message); exit(1); }
}
static double percentile(std::vector<double> values, double p) {
  std::sort(values.begin(), values.end());
  return values[size_t(p * (values.size() - 1))];
}
static void metric(const char* name, const std::vector<double>& values,
                   bool comma = true) {
  printf("\"%s\":{\"p50_us\":%.6f,\"p95_us\":%.6f,\"p99_us\":%.6f}%s",
         name, percentile(values, .5), percentile(values, .95),
         percentile(values, .99), comma ? "," : "");
}

__attribute__((noinline))
static uint64_t checksum(const uint32_t* data, size_t count) {
  uint64_t result = 0;
  for (size_t i = 0; i < count; ++i) result += data[i];
  return result;
}

static id<MTLCommandBuffer> encode(id<MTLCommandQueue> queue,
    id<MTLComputePipelineState> pipeline, id<MTLBuffer> buffer,
    size_t count, uint32_t bias) {
  id<MTLCommandBuffer> command = [queue commandBuffer];
  id<MTLComputeCommandEncoder> encoder = [command computeCommandEncoder];
  [encoder setComputePipelineState:pipeline];
  [encoder setBuffer:buffer offset:0 atIndex:0];
  [encoder setBytes:&bias length:sizeof(bias) atIndex:1];
  NSUInteger group = std::min<size_t>(256, count);
  group = std::min(group, pipeline.maxTotalThreadsPerThreadgroup);
  [encoder dispatchThreads:MTLSizeMake(count, 1, 1)
      threadsPerThreadgroup:MTLSizeMake(group, 1, 1)];
  [encoder endEncoding];
  return command;
}

static void check_command(id<MTLCommandBuffer> command) {
  if (command.status != MTLCommandBufferStatusCompleted) {
    fprintf(stderr, "Metal failure: %s\n",
        command.error.localizedDescription.UTF8String);
    exit(1);
  }
}

int main() {
  @autoreleasepool {
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    ns_per_tick = double(timebase.numer) / timebase.denom;
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    require(device != nil && device.hasUnifiedMemory, "Unified Metal GPU required");
    NSError* error = nil;
    NSString* source = @"#include <metal_stdlib>\n"
      "using namespace metal;\n"
      "kernel void fill(device uint* out [[buffer(0)]],"
      "constant uint& bias [[buffer(1)]],"
      "uint i [[thread_position_in_grid]]) { out[i] = i + bias; }\n";
    id<MTLLibrary> library = [device newLibraryWithSource:source
        options:nil error:&error];
    require(library != nil, error.localizedDescription.UTF8String);
    id<MTLComputePipelineState> pipeline = [device
        newComputePipelineStateWithFunction:[library newFunctionWithName:@"fill"]
        error:&error];
    require(pipeline != nil, error.localizedDescription.UTF8String);
    id<MTLCommandQueue> queue = [device newCommandQueue];

    // Verify the shader and CPU checksum against a closed-form answer first.
    id<MTLBuffer> test = [device newBufferWithLength:4096
        options:MTLResourceStorageModeShared];
    auto test_command = encode(queue, pipeline, test, 1024, 17);
    [test_command commit];
    [test_command waitUntilCompleted];
    check_command(test_command);
    require(checksum((uint32_t*)test.contents, 1024) ==
        uint64_t(1024) * 1023 / 2 + uint64_t(1024) * 17,
        "Preflight checksum failed");

    printf("{\"device\":\"%s\",\"os\":\"%s\",\"preflight\":\"pass\",",
        device.name.UTF8String,
        NSProcessInfo.processInfo.operatingSystemVersionString.UTF8String);

    // Warm PSO, queue, buffer and pages; one command is in flight at a time.
    const int warmup = 100, repetitions = 1000;
    id<MTLBuffer> scalar = [device newBufferWithLength:4096
        options:MTLResourceStorageModeShared];
    volatile uint32_t* scalar_pointer = (volatile uint32_t*)scalar.contents;
    std::vector<double> total, submit_wait, gpu, resume;
    for (int i = -warmup; i < repetitions; ++i) {
      @autoreleasepool {
        uint32_t bias = uint32_t(i + warmup + 1);
        uint64_t t0 = tick();
        auto command = encode(queue, pipeline, scalar, 1, bias);
        uint64_t t1 = tick();
        [command commit];
        [command waitUntilCompleted];
        uint64_t t2 = tick();
        uint32_t value = scalar_pointer[0];
        uint64_t t3 = tick();
        check_command(command);
        require(value == bias, "Scalar result failed");
        require(command.GPUEndTime >= command.GPUStartTime &&
            command.GPUStartTime > 0, "GPU timestamps unavailable");
        sink = value;
        if (i >= 0) {
          total.push_back(us(t0, t3));
          submit_wait.push_back(us(t1, t2));
          gpu.push_back((command.GPUEndTime - command.GPUStartTime) * 1e6);
          resume.push_back((double(t2) * ns_per_tick / 1e9 -
              command.GPUEndTime) * 1e6);
        }
      }
    }
    printf("\"scalar\":{\"samples\":%d,\"warmup\":%d,", repetitions, warmup);
    metric("encode_submit_wait_read", total);
    metric("submit_wait", submit_wait);
    metric("gpu_command", gpu);
    metric("gpu_end_to_wait_return", resume, false);
    printf("},");

    // Isolate the ready path, averaging 1000 calls per timing sample.
    auto ready_command = encode(queue, pipeline, scalar, 1, 7);
    [ready_command commit];
    [ready_command waitUntilCompleted];
    check_command(ready_command);
    std::vector<double> ready;
    for (int sample = -10; sample < 100; ++sample) {
      uint64_t sum = 0;
      uint64_t start = tick();
      for (int j = 0; j < 1000; ++j) {
        [ready_command waitUntilCompleted];
        sum += scalar_pointer[0];
      }
      uint64_t end = tick();
      require(sum == 7000, "Ready-path result failed");
      sink = sum;
      if (sample >= 0) ready.push_back(us(start, end) / 1000.0);
    }
    metric("already_completed_wait_and_scalar_read_per_call", ready);
    printf("\"cpu_reads_after_gpu_write\":[");

    const size_t sizes[] = {4096, 1ul << 20, 16ul << 20, 64ul << 20};
    for (int s = 0; s < 4; ++s) {
      size_t bytes = sizes[s], count = bytes / sizeof(uint32_t);
      id<MTLBuffer> buffer = [device newBufferWithLength:bytes
          options:MTLResourceStorageModeShared];
      require(buffer != nil, "Buffer allocation failed");
      auto data = (const uint32_t*)buffer.contents;
      std::vector<double> first_read, second_read, write_gpu;
      for (int i = -5; i < 40; ++i) {
        @autoreleasepool {
          uint32_t bias = uint32_t(i + 6);
          auto command = encode(queue, pipeline, buffer, count, bias);
          [command commit];
          [command waitUntilCompleted];
          check_command(command);
          asm volatile("" ::: "memory");
          uint64_t t0 = tick();
          uint64_t a = checksum(data, count);
          uint64_t t1 = tick();
          asm volatile("" ::: "memory");
          uint64_t b = checksum(data, count);
          uint64_t t2 = tick();
          uint64_t expected = uint64_t(count) * (count - 1) / 2 +
              uint64_t(count) * bias;
          require(a == expected && b == expected, "Array checksum failed");
          sink = a + b;
          if (i >= 0) {
            first_read.push_back(us(t0, t1));
            second_read.push_back(us(t1, t2));
            write_gpu.push_back((command.GPUEndTime - command.GPUStartTime) * 1e6);
          }
        }
      }
      if (s) printf(",");
      printf("{\"bytes\":%zu,\"samples\":40,", bytes);
      metric("first_cpu_checksum", first_read);
      metric("second_cpu_checksum", second_read);
      metric("gpu_fill", write_gpu, false);
      printf("}");
    }
    printf("]}\n");
  }
  return 0;
}
