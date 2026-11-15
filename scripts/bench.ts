import { performance } from 'node:perf_hooks';
import { readFileSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseGpuBatch, parseGpuModules } from '../src/gpu.ts';
import { parseReference } from '../src/reference.ts';
import { parseModuleReference } from '../src/module-reference.ts';
const quantile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.ceil((values.length-1)*p)];
const records=[];
const cases=[
  ...[16,256,4096].map(terms=>({language:'expression',
    source:Array.from({length:terms},(_,i)=>`(v${i}+${i%100})*3`).join('+')})),
  ...[1,32,256].map(count=>({language:'module',source:Array.from({length:count},(_,i)=>
    `fn f${i}(x:u32,y:u32):u32{${Array.from({length:32},(_,j)=>`(x+${j})*y`).join('+')}}`).join('\n')})),
];
for(const {language,source} of cases) {
  const cpu=language==='module' ? parseModuleReference : parseReference;
  const gpuParse=language==='module' ? parseGpuModules : parseGpuBatch;
  const samples:number[]=[];
  for(let i=0;i<23;i++) {
    const start=performance.now();
    const reference=cpu(source);
    if(reference.diagnostic) throw new Error('Invalid benchmark input');
    if(i>=3) samples.push((performance.now()-start)*1000);
  }
  const start=performance.now();
  const [gpu]=gpuParse([source],64,23);
  const batchWallUs=(performance.now()-start)*1000;
  if(gpu.diagnostic) throw new Error(JSON.stringify(gpu.diagnostic));
  records.push({language,bytes:Buffer.byteLength(source),nodes:gpu.nodes.length,samples:20,
    cpuReferenceP50Us:quantile(samples,.5),
    gpuFrontendP50Us:quantile(gpu.samplesUs.slice(3),.5),
    gpuFrontendP95Us:quantile(gpu.samplesUs.slice(3),.95),
    gpuDeviceP50Us:quantile(gpu.gpuSamplesUs.slice(3),.5),
    librarySetupUs:gpu.setupUs,batchWallUs,arenaBytes:gpu.arenaBytes,dispatches:gpu.dispatches,
    diagnostics:gpu.diagnostics,diagnosticDispatches:gpu.diagnosticDispatches,mslVersion:gpu.mslVersion,
    device:gpu.device});
}
const root=fileURLToPath(new URL('../',import.meta.url));
const sourceHashes=Object.fromEntries(['native/contract.h','native/passes.h','native/frontend.metal','native/module.metal',
  'native/main.mm','src/reference.ts','src/module-reference.ts','src/contract.ts','src/gpu.ts','scripts/bench.ts']
  .map(path=>[path,createHash('sha256').update(readFileSync(`${root}${path}`)).digest('hex')]));
const output={measuredAt:new Date().toISOString(),node:process.version,
  macOS:execFileSync('sw_vers',['-productVersion'],{encoding:'utf8'}).trim(),
  compiler:execFileSync('xcrun',['clang++','--version'],{encoding:'utf8'}).split('\n')[0],
  sourceHashes,notes:[
  'GPU frontend includes allocation, initialization, encode/submit and one completion wait; excludes final JSON materialization.',
  'Device interval and process/library setup are separate. Batch wall time includes startup, 23 runs and final AST JSON.',
  'CPU is a TypeScript correctness oracle, not an optimized CPU performance baseline. No speedup claim.',
  '20 retained samples after 3 warmups; p95 is descriptive, not a stable tail-latency estimate.'
],records};
writeFileSync(fileURLToPath(new URL('../build/benchmark.json',import.meta.url)),JSON.stringify(output,null,2)+'\n');
console.table(records.map(r=>({language:r.language,bytes:r.bytes,nodes:r.nodes,
  'CPU oracle µs':Math.round(r.cpuReferenceP50Us),
  'GPU frontend µs':Math.round(r.gpuFrontendP50Us),'GPU device µs':Math.round(r.gpuDeviceP50Us),
  dispatches:r.dispatches})));
