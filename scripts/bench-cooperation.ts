import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseModuleReference } from '../src/module-reference.ts';
import type { GpuSummary } from '../src/contract.ts';

interface Experimental extends GpuSummary {
  feedbackEvery:number; feedbackWaits:number; dispatchSignature:string;
  feedbackSamples:{dispatches:number;elapsedUs:number;readUs:number;gpuUs:number;tokenCount:number;nodeCount:number}[];
}
const root=fileURLToPath(new URL('../',import.meta.url));
const sha=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
const quantile=(xs:number[],p:number)=>[...xs].sort((a,b)=>a-b)[Math.ceil((xs.length-1)*p)];
const warmups=2,samples=10,intervals=[0,32,8,1],records=[];
for(const functions of [1,32,256]) {
  const source=Array.from({length:functions},(_,i)=>`fn f${i}(x:u32,y:u32):u32{${
    Array.from({length:8},(_,j)=>`(x+${j})*y`).join('+')}}`).join('\n');
  const expected=parseModuleReference(source);
  const rows=intervals.map(feedbackEvery=>({functions,feedbackEvery,trials:[] as {
    jobUs:number;frontendUs:number;gpuUs:number;cpuReadUs:number;feedbackWaits:number;hostWaits:number;
    dispatches:number;dispatchSignature:string;device:string;mslVersion:string;feedbackSamples:Experimental['feedbackSamples'];
  }[]}));
  let signature:string|undefined;
  for(let round=0;round<warmups+samples;round++) for(let order=0;order<intervals.length;order++) {
    const index=(round+order)%intervals.length,feedbackEvery=intervals[index];
    const [r]=JSON.parse(execFileSync(`${root}build/frontend-feedback`,[`${root}native`],{
      input:JSON.stringify({sources:[source],language:'module',output:'summary',maxInFlight:1,repeat:2,feedbackEvery}),
      encoding:'utf8',maxBuffer:16*1024*1024,
    })) as Experimental[];
    assert.equal(r.mslVersion,'4.0'); assert.equal(r.diagnostic,null);
    assert.equal(r.tokenCount,expected.tokens.length); assert.equal(r.nodeCount,expected.nodes.length);
    assert.equal(r.functionCount,expected.functions.length); assert.equal(r.allocationSamples[1],0);
    signature??=r.dispatchSignature;
    assert.equal(r.dispatchSignature,signature,'kernel plan changed across feedback modes');
    assert.equal(r.hostWaits,r.feedbackWaits+1);
    if(round<warmups) continue;
    const trace=r.flightSamples.at(-1)!;
    rows[index].trials.push({jobUs:trace.consumeEndUs-trace.prepareBeginUs,frontendUs:r.elapsedUs,gpuUs:r.gpuUs,
      cpuReadUs:r.feedbackSamples.reduce((sum,s)=>sum+s.readUs,0),feedbackWaits:r.feedbackWaits,hostWaits:r.hostWaits,
      dispatches:r.dispatches,dispatchSignature:r.dispatchSignature,device:r.device,mslVersion:r.mslVersion,
      feedbackSamples:r.feedbackSamples});
  }
  for(const row of rows) records.push({...row,bytes:Buffer.byteLength(source),nodes:expected.nodes.length,inputHash:sha(source),
    jobP50Us:quantile(row.trials.map(t=>t.jobUs),.5),jobP95Us:quantile(row.trials.map(t=>t.jobUs),.95),
    gpuP50Us:quantile(row.trials.map(t=>t.gpuUs),.5),cpuReadP50Us:quantile(row.trials.map(t=>t.cpuReadUs),.5)});
}
const paths=['native/contract.h','native/passes.h','native/buffers.h','native/arena.h','native/flight.h','native/batch.h',
  'native/feedback.h','native/frontend.metal','native/module.metal','native/main.mm','scripts/build.mjs',
  'scripts/bench-cooperation.ts','src/contract.ts','src/reference.ts','src/module-reference.ts'];
const output={measuredAt:new Date().toISOString(),node:process.version,
  macOS:execFileSync('sw_vers',['-productVersion'],{encoding:'utf8'}).trim(),
  compiler:execFileSync('xcrun',['clang++','--version'],{encoding:'utf8'}).split('\n')[0],
  binary:'frontend-feedback',buildFlags:['-O3','-std=c++17','-fobjc-arc','-DMETALIC_FEEDBACK_EXPERIMENT=1'],
  warmups,samples,sourceHashes:Object.fromEntries(paths.map(path=>[path,sha(readFileSync(`${root}${path}`))])),notes:[
    'Experiment-only binary. Production frontend-metal rejects feedbackEvery; no intermediate host readback is added to the public API.',
    'Same kernels, Params, launch bounds, order and final compact output; FNV-1a plan signatures are checked across modes.',
    'Checkpoints split command buffers and wait, then read two u32 counts before resuming unchanged dispatches.',
    'This artificially imposes feedback; counts never change useful work or launch bounds. Real semantic decisions may add other costs.',
    'Two discarded rounds, 10 retained rounds with rotating mode order. Each native request warms once then measures its second job.',
    'One slot; selective pool is warm for the retained job. Library/process setup, first job and JSON/IPC are excluded from jobUs.',
    'jobUs is prepareBegin through consumeEnd, including final summary construction. GPU time sums ALL checkpoint buffers and the final buffer.',
    'encodeUs in this experimental binary includes intermediate commit/wait/read; it is not CPU-only encoding time.',
    'Checkpoint scalar read timing starts AFTER GPU completion. It is not submission/wait or pure readback latency.',
    'Splitting commands also changes GPU scheduling/encoder boundaries. Differences are full feedback-path costs, not a universal per-wait constant.',
    'No optimized native CPU baseline. OS load, scheduling and frequency remain uncontrolled; p95 from 10 samples is descriptive.',
  ],records};
writeFileSync(`${root}build/cooperation-benchmark.json`,JSON.stringify(output,null,2)+'\n');
console.table(records.map(r=>({functions:r.functions,every:r.feedbackEvery,dispatches:r.trials[0].dispatches,
  waits:r.trials[0].hostWaits,'job p50 ms':+(r.jobP50Us/1000).toFixed(3),
  'job p95 ms':+(r.jobP95Us/1000).toFixed(3),'GPU sum ms':+(r.gpuP50Us/1000).toFixed(3),
  'CPU scalar reads µs':+r.cpuReadP50Us.toFixed(3)})));
