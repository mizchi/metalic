#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
int main() { @autoreleasepool {
  id<MTLDevice> device=MTLCreateSystemDefaultDevice();
  if(!device) { fprintf(stderr,"No Metal device\n"); return 1; }
  MTLCompileOptions* options=[MTLCompileOptions new];
  // The SDK's existing MTLLanguageVersion enum uses major<<16 | minor.
  // Request 4.1 explicitly to probe the runtime even with the older headers.
  options.languageVersion=static_cast<MTLLanguageVersion>((4u<<16)|1u);
  NSString* source=@"#include <metal_stdlib>\nusing namespace metal;\n#if __METAL_VERSION__ != 410\n#error MSL_4_1_required\n#endif\nkernel void probe(device uint* out [[buffer(0)]]) { out[0]=__METAL_VERSION__; }\n";
  NSError* error=nil;
  @try {
    id<MTLLibrary> library=[device newLibraryWithSource:source options:options error:&error];
    printf("device=%s requested=MSL4.1 result=%s\n",device.name.UTF8String,library ? "compiled" : "unsupported");
    if(!library) { fprintf(stderr,"%s\n",error.localizedDescription.UTF8String); return 1; }
  } @catch(NSException* exception) {
    fprintf(stderr,"MSL4.1 rejected: %s\n",exception.reason.UTF8String); return 1;
  }
  return 0;
}}
