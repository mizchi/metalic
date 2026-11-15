import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseReference } from '../src/reference.ts';
import { parseModuleReference } from '../src/module-reference.ts';
import type { GpuModuleResult, DiagnosticStrategy } from '../src/contract.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const strategies:DiagnosticStrategy[]=['tree','hierarchical','packed'];
const warmups=3, samples=30, repeat=warmups+samples+1;
const quantile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.ceil((values.length-1)*p)];
const jobs=[
  {name:'expression-small',language:'expression',source:'1+2*3'},
  {name:'expression-large',language:'expression',source:Array.from({length:4096},(_,i)=>`(v${i}+${i%100})*3`).join('+')},
  ...[1,256].map(count=>({name:`module-${count}`,language:'module',source:Array.from({length:count},(_,i)=>
    `fn f${i}(x:u32,y:u32):u32{${Array.from({length:32},(_,j)=>`(x+${j})*y`).join('+')}}`).join('\n')})),
  {name:'comment-heavy',language:'expression',source:'/*'+' '.repeat(65532)+'*/1'},
  {name:'error-storm',language:'expression',source:'@'.repeat(65537)},
  {name:'resolution-errors',language:'module',source:Array.from({length:256},(_,i)=>`fn f${i}():u32{missing}`).join('\n')},
  {name:'maximum-eof',language:'expression',source:'/*'+' '.repeat(1048576-2)},
];
const records=[];
for(const job of jobs) {
  const expected=job.language==='module' ? parseModuleReference(job.source) : parseReference(job.source);
  const start=performance.now();
  const output=execFileSync(`${root}build/frontend-metal`,[`${root}native`],{
    input:JSON.stringify({sources:[job.source],language:job.language,chunkSize:64,repeat,diagnostics:strategies}),
    encoding:'utf8',maxBuffer:256*1024*1024,stdio:['pipe','pipe','pipe'],
  });
  const wallUs=(performance.now()-start)*1000;
  const results=JSON.parse(output) as GpuModuleResult[];
  assert.equal(results.length,strategies.length);
  for(const [i,actual] of results.entries()) {
    assert.equal(actual.diagnostics,strategies[i]);
    assert.equal(actual.mslVersion,'4.0');
    assert.equal(actual.hostWaits,1);
    assert.deepEqual(actual.tokens,expected.tokens);
    assert.deepEqual(actual.nodes,expected.nodes);
    assert.equal(actual.root,expected.root);
    assert.deepEqual(actual.diagnostic,expected.diagnostic);
    if('functions' in expected) assert.deepEqual(actual.functions,expected.functions);
    const frontend=actual.samplesUs.slice(warmups,-1), device=actual.gpuSamplesUs.slice(warmups,-1);
    assert.equal(frontend.length,samples);
    records.push({case:job.name,language:job.language,bytes:Buffer.byteLength(job.source),
      inputHash:createHash('sha256').update(job.source).digest('hex'),nodes:actual.nodes.length,
      diagnostics:actual.diagnostics,dispatches:actual.dispatches,diagnosticDispatches:actual.diagnosticDispatches,
      arenaBytes:actual.arenaBytes,hostWaits:actual.hostWaits,mslVersion:actual.mslVersion,device:actual.device,
      frontendP50Us:quantile(frontend,.5),frontendP95Us:quantile(frontend,.95),
      deviceP50Us:quantile(device,.5),samplesUs:frontend,gpuSamplesUs:device,
      setupUs:actual.setupUs,comparisonWallUs:wallUs});
  }
}
const sourceHashes=Object.fromEntries(['native/contract.h','native/passes.h','native/frontend.metal','native/module.metal',
  'native/main.mm','scripts/generate.mjs','scripts/bench-diagnostics.ts','src/contract.ts','src/gpu.ts',
  'src/reference.ts','src/module-reference.ts'].map(path=>[path,createHash('sha256').update(readFileSync(`${root}${path}`)).digest('hex')]));
const output={measuredAt:new Date().toISOString(),node:process.version,
  macOS:execFileSync('sw_vers',['-productVersion'],{encoding:'utf8'}).trim(),
  compiler:execFileSync('xcrun',['clang++','--version'],{encoding:'utf8'}).split('\n')[0],
  metalCompiler:execFileSync('xcrun',['metal','--version'],{encoding:'utf8'}).trim(),
  warmups,samples,sourceHashes,notes:[
    'Each case compares three diagnostic schedules in one native process/library. Strategy execution order rotates each round.',
    'Three warmups, 30 retained rounds, then one final result-materialization round omitted from statistics.',
    'Frontend includes allocation, initialization, encode/submit and the final wait; excludes setup and final AST/JSON materialization.',
    'Device interval is measured separately; the difference of medians is not pure host or readback cost.',
    'comparisonWallUs includes all strategies, 34 rounds each, startup and final JSON; it repeats across the three rows of a case.',
    'All token/AST/binding/type/diagnostic results are checked against the independent CPU oracle. No native CPU speedup claim.',
    'p95 is descriptive for 30 samples. Source order, OS scheduling and GPU frequency remain uncontrolled.',
  ],records};
writeFileSync(`${root}build/diagnostics-benchmark.json`,JSON.stringify(output,null,2)+'\n');
console.table(records.map(r=>({case:r.case,strategy:r.diagnostics,dispatches:r.dispatches,
  'diagnostic dispatches':r.diagnosticDispatches,'frontend µs':Math.round(r.frontendP50Us),
  'device µs':Math.round(r.deviceP50Us)})));
