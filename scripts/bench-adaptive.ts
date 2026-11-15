import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { AdaptiveScheduler } from '../src/adaptive.ts';
import type { WorkloadSpec, WorkloadMode, AdaptiveResult, WorkloadHandle } from '../src/contract.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
if([process.env.MTL_DEBUG_LAYER,process.env.MTL_SHADER_VALIDATION].some(v=>v&&v!=='0'))
  throw new Error('Run performance benchmarks without Metal validation');
const directory=await mkdtemp(`${root}build/adaptive-bench-`),profilePath=`${directory}/profile.json`;
const definitions:{name:string;spec:WorkloadSpec;placement:'cpu'|'resident'}[]=[
  {name:'compact-small',spec:{algorithm:'compact-u32',count:65536},placement:'cpu'},
  {name:'compact-large',spec:{algorithm:'compact-u32',count:16777216},placement:'cpu'},
  {name:'merkle-large',spec:{algorithm:'merkle-sha256',count:262144},placement:'cpu'},
  {name:'histogram-cpu',spec:{algorithm:'histogram256',count:16777216},placement:'cpu'},
  {name:'histogram-resident',spec:{algorithm:'histogram256',count:16777216},placement:'resident'},
];
const quantile=(xs:number[],p:number)=>[...xs].sort((a,b)=>a-b)[Math.ceil((xs.length-1)*p)];
const samples=15;
let scheduler=await AdaptiveScheduler.open({profilePath});
const info=scheduler.info,handles:WorkloadHandle[]=[],cases=[];
try {
  for(const d of definitions) handles.push(await scheduler.prepare(d.spec,{inputPlacement:d.placement}));
  for(const [index,d] of definitions.entries()) {
    const handle=handles[index],started=performance.now();
    const calibration=await scheduler.calibrate(handle,3),calibrationUs=(performance.now()-started)*1000;
    const candidates:WorkloadMode[]=['cpu-serial','cpu-parallel',d.placement==='resident'?'gpu-resident':'gpu-upload'];
    const variants=[...candidates,'auto'] as const;
    const evaluations:{iteration:number;variant:string;apiUs:number;result:AdaptiveResult}[]=[];
    for(let iteration=0;iteration<samples;iteration++) for(let order=0;order<variants.length;order++) {
      const variant=variants[(iteration+order)%variants.length],start=performance.now();
      const result=await scheduler.run(handle,variant==='auto' ? {} : {mode:variant,learn:false});
      const apiUs=(performance.now()-start)*1000;
      assert.equal(result.verified,true);
      assert.equal(result.checksum,calibration[0].checksum);
      assert.equal(result.resultCount,calibration[0].resultCount);
      evaluations.push({iteration,variant,apiUs,result});
    }
    const summaries=Object.fromEntries(variants.map(variant=> {
      const rows=evaluations.filter(r=>r.variant===variant);
      return [variant,{p50Us:quantile(rows.map(r=>r.apiUs),.5),p95Us:quantile(rows.map(r=>r.apiUs),.95),
        sumUs:rows.reduce((sum,r)=>sum+r.apiUs,0),modes:Object.fromEntries(candidates.map(m=>[m,rows.filter(r=>r.result.mode===m).length]))}];
    }));
    cases.push({...d,inputHash:handle.inputHash,profileKey:handle.profileKey,reservedBytes:handle.reservedBytes,
      prepareUs:handle.prepareUs,calibrationUs,calibration,evaluations,summaries,profile:scheduler.profile(handle)});
  }
  const large=handles[2],bulk=[];
  const bulkVariants=['gpu-only','adaptive','adaptive-updated'];
  for(let round=0;round<3;round++) for(let order=0;order<bulkVariants.length;order++) {
    const variant=bulkVariants[(round+order)%bulkVariants.length];
    // Warm the same shape before each batch, including the fixed GPU control.
    await scheduler.run(large,{mode:'gpu-upload',learn:false});
    const start=performance.now();
    const results=variant==='gpu-only' ? await Promise.all(Array.from({length:16},()=>scheduler.run(large,{mode:'gpu-upload',learn:false})))
      : await scheduler.runBatch(Array.from({length:16},()=>large));
    const wallUs=(performance.now()-start)*1000;
    assert.ok(results.every(r=>r.verified&&r.digestHex===results[0].digestHex));
    bulk.push({round,variant,wallUs,results});
  }
  await scheduler.flush();
  const savedProfile=JSON.parse(await readFile(profilePath,'utf8'));
  await scheduler.close();
  scheduler=await AdaptiveScheduler.open({profilePath});
  assert.equal(scheduler.info.profileStatus,'loaded');
  const restored=await scheduler.prepare({...definitions[2].spec,seed:17});
  assert.equal(scheduler.profile(restored).trained,true);
  const resumed=await scheduler.run(restored);
  const replay={profileStatus:scheduler.info.profileStatus,profile:scheduler.profile(restored),result:resumed};
  const paths=['native/contract.h','native/buffers.h','native/workloads_runtime.h','native/workloads_cpu.h','native/workloads_plan.h',
    'native/workload-worker.mm','native/workloads.metal','scripts/build.mjs','src/adaptive.ts','src/adaptive-worker.ts',
    'src/adaptive-policy.ts','src/adaptive-profile.ts','src/contract.ts','src/workload-spec.ts','scripts/bench-adaptive.ts'];
  const sourceHashes=Object.fromEntries(await Promise.all(paths.map(async p=>[p,createHash('sha256').update(await readFile(`${root}${p}`)).digest('hex')])));
  const output={measuredAt:new Date().toISOString(),node:process.version,
    macOS:execFileSync('sw_vers',['-productVersion'],{encoding:'utf8'}).trim(),
    compiler:execFileSync('xcrun',['clang++','--version'],{encoding:'utf8'}).split('\n')[0],sourceHashes,info,samples,
    notes:[
      'Persistent CPU/GPU native workers. Immutable prepared input replicas are fully verified and bounded by a logical memory reservation.',
      'Preparation includes deterministic input generation, reference computation and initial GPU upload; its cold cost is reported separately.',
      'Calibration: one excluded warmup per candidate followed by three retained runs each in rotating order.',
      'Placement scores use RPC service wall time including native full-output verification, JSON/IPC and CPU result consumption; scheduler queue time is separate.',
      'Evaluation API times include placement overhead. CPU/GPU fixed and auto modes rotate order; forced controls do not update learned profiles.',
      'Automatic mode keeps learning and periodically explores; no result memoization or partial-job CPU/GPU migration.',
      'Bulk variants use identical immutable Merkle inputs; concurrent CPU/GPU lanes may compete for shared bandwidth and CPU resources.',
      'Bulk: three rounds of sixteen jobs per variant, rotating variant order, with an excluded GPU warmup before each batch; adaptive profiles carry forward.',
      'contended means overlap of lane request lifetimes, not hardware active-cycle profiling.',
      'OS load, scheduling and frequency are uncontrolled. Fifteen samples are descriptive, not a general speedup guarantee.',
    ],cases,bulk,replay,savedProfile};
  await writeFile(`${root}build/adaptive-benchmark.json`,JSON.stringify(output,null,2)+'\n');
  console.table(cases.map(c=>({case:c.name,'prepare ms':+(c.prepareUs/1000).toFixed(2),'learn ms':+(c.calibrationUs/1000).toFixed(2),
    'CPU serial ms':+(c.summaries['cpu-serial'].p50Us/1000).toFixed(3),
    'CPU parallel ms':+(c.summaries['cpu-parallel'].p50Us/1000).toFixed(3),
    'GPU ms':+(c.summaries[c.placement==='resident'?'gpu-resident':'gpu-upload'].p50Us/1000).toFixed(3),
    'auto ms':+(c.summaries.auto.p50Us/1000).toFixed(3),selected:JSON.stringify(c.summaries.auto.modes)})));
  console.table(bulk.map(b=>({round:b.round,variant:b.variant,'batch ms':+(b.wallUs/1000).toFixed(3),
    cpu:b.results.filter(r=>r.mode.startsWith('cpu')).length,gpu:b.results.filter(r=>r.mode.startsWith('gpu')).length})));
} finally { await scheduler.close(); }
