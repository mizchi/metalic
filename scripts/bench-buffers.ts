import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseReference } from '../src/reference.ts';
import { parseModuleReference } from '../src/module-reference.ts';
import type { GpuModuleResult, BufferStrategy, TimingBreakdown } from '../src/contract.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const modes:BufferStrategy[]=['fresh','reuse','selective'];
const warmups=3,samples=30,repeat=warmups+samples+1;
const quantile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.ceil((values.length-1)*p)];
const jobs=[
  {name:'expression-small',language:'expression',source:'1+2*3'},
  {name:'expression-large',language:'expression',source:Array.from({length:4096},(_,i)=>`(v${i}+${i%100})*3`).join('+')},
  ...[1,256].map(count=>({name:`module-${count}`,language:'module',source:Array.from({length:count},(_,i)=>
    `fn f${i}(x:u32,y:u32):u32{${Array.from({length:32},(_,j)=>`(x+${j})*y`).join('+')}}`).join('\n')})),
  {name:'comment-heavy',language:'expression',source:'/*'+' '.repeat(65532)+'*/1'},
  {name:'error-storm',language:'expression',source:'@'.repeat(65537)},
  {name:'maximum-eof',language:'expression',source:'/*'+' '.repeat(1048576-2)},
];
const records=[];
for(const job of jobs) {
  const expected=job.language==='module' ? parseModuleReference(job.source) : parseReference(job.source);
  const start=performance.now();
  const output=execFileSync(`${root}build/frontend-metal`,[`${root}native`],{
    input:JSON.stringify({sources:[job.source],language:job.language,chunkSize:64,repeat,diagnostics:'packed',buffers:modes}),
    encoding:'utf8',maxBuffer:256*1024*1024,stdio:['pipe','pipe','pipe'],
  });
  const comparisonWallUs=(performance.now()-start)*1000;
  const results=JSON.parse(output) as GpuModuleResult[];
  assert.equal(results.length,modes.length);
  for(const [i,actual] of results.entries()) {
    assert.equal(actual.buffers,modes[i]); assert.equal(actual.mslVersion,'4.0'); assert.equal(actual.hostWaits,1);
    assert.deepEqual(actual.tokens,expected.tokens); assert.deepEqual(actual.nodes,expected.nodes);
    assert.equal(actual.root,expected.root); assert.deepEqual(actual.diagnostic,expected.diagnostic);
    if('functions' in expected) assert.deepEqual(actual.functions,expected.functions);
    const frontend=actual.samplesUs.slice(warmups,-1),device=actual.gpuSamplesUs.slice(warmups,-1);
    const timings=actual.timingSamplesUs.slice(warmups,-1),allocations=actual.allocationSamples.slice(warmups,-1);
    assert.equal(frontend.length,samples); assert.equal(timings.length,samples);
    timings.forEach((t,j)=>assert.ok(Math.abs(t.prepareUs+t.acquireUs+t.initializeUs+t.encodeUs+t.submitWaitUs-frontend[j])<.001));
    assert.ok(allocations.every(n=>n===(i===0 ? 2 : 0)));
    const phaseP50Us=Object.fromEntries((Object.keys(timings[0]) as (keyof TimingBreakdown)[]).filter(key=>key!=='materializeUs')
      .map(key=>[key,quantile(timings.map(t=>t[key]),.5)]));
    records.push({case:job.name,language:job.language,bytes:Buffer.byteLength(job.source),
      inputHash:createHash('sha256').update(job.source).digest('hex'),nodes:actual.nodes.length,buffers:actual.buffers,
      diagnostics:actual.diagnostics,mslVersion:actual.mslVersion,device:actual.device,
      dispatches:actual.dispatches,arenaBytes:actual.arenaBytes,arenaCapacityBytes:actual.arenaCapacityBytes,
      sourceCapacityBytes:actual.sourceCapacityBytes,initializedBytes:actual.initializedBytes,
      frontendP50Us:quantile(frontend,.5),frontendP95Us:quantile(frontend,.95),deviceP50Us:quantile(device,.5),
      phaseP50Us,samplesUs:frontend,gpuSamplesUs:device,timingSamplesUs:timings,allocationSamples:allocations,
      firstRunUs:actual.samplesUs[0],firstAllocationCount:actual.allocationSamples[0],
      finalMaterializeUs:actual.timingsUs.materializeUs,setupUs:actual.setupUs,comparisonWallUs});
  }
}
const sourceHashes=Object.fromEntries(['native/contract.h','native/passes.h','native/buffers.h','native/arena.h',
  'native/frontend.metal','native/module.metal','native/main.mm','scripts/build.mjs','scripts/bench-buffers.ts',
  'src/contract.ts','src/gpu.ts','src/reference.ts','src/module-reference.ts']
  .map(path=>[path,createHash('sha256').update(readFileSync(`${root}${path}`)).digest('hex')]));
const output={measuredAt:new Date().toISOString(),node:process.version,
  macOS:execFileSync('sw_vers',['-productVersion'],{encoding:'utf8'}).trim(),
  compiler:execFileSync('xcrun',['clang++','--version'],{encoding:'utf8'}).split('\n')[0],
  warmups,samples,sourceHashes,notes:[
    'Each case compares fresh/full reset, pooled/full reset and pooled/selective reset in one native process/library.',
    'Execution order rotates each round; three warmups, 30 retained rounds and one excluded materialization round.',
    'Frontend is the sum of prepare, acquire, initialize, encode and commit/wait intervals of EACH sample.',
    'Materialize covers result validation and native AST object creation; final JSON encoding/output and JS JSON.parse are separate.',
    'Retained rounds do not extract AST objects; finalMaterializeUs is one final extraction sample and is not a median.',
    'prepare includes UTF-8 encoding and layout planning; initialize includes source copy and arena reset. Poisoning is disabled.',
    'Phase medians do not sum to the median frontend time. submitWait includes GPU work and notification, not pure readback.',
    'Arena capacity is allocated resource length, not process RSS. Pooled modes retain power-of-two high-water buffers until Runtime exit.',
    'Reuse is within a native request across sources/repeats. Each TS API call still starts a native process.',
    'All outputs match the independent CPU oracle; this is not a native CPU performance comparison. OS/frequency remain uncontrolled.',
  ],records};
writeFileSync(`${root}build/buffers-benchmark.json`,JSON.stringify(output,null,2)+'\n');
console.table(records.map(r=>({case:r.case,buffers:r.buffers,'frontend µs':Math.round(r.frontendP50Us),
  'acquire µs':Math.round(r.phaseP50Us.acquireUs),'initialize µs':Math.round(r.phaseP50Us.initializeUs),
  'encode µs':Math.round(r.phaseP50Us.encodeUs),'commit/wait µs':Math.round(r.phaseP50Us.submitWaitUs),
  'device µs':Math.round(r.deviceP50Us),'initialized bytes':r.initializedBytes})));
