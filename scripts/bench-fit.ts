import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdaptiveScheduler } from '../src/adaptive.ts';
import { policyDefaults } from '../src/adaptive-policy.ts';
import { fitCases } from '../src/fit-cases.ts';
import { assessFit } from '../src/fit.ts';
import type { AdaptiveResult,FitSample,WorkloadMode,AdaptivePolicyConfig } from '../src/contract.ts';

const {values}=parseArgs({options:Object.fromEntries(['min-samples','window','recheck-every','switch-margin','samples','block','seed','output'].map(k=>[k,{type:'string' as const}]))});
const numeric=(key:string,fallback:number)=>values[key]===undefined ? fallback : Number(values[key]);
const policy:AdaptivePolicyConfig={minSamples:numeric('min-samples',policyDefaults.minSamples),window:numeric('window',policyDefaults.window),
  recheckEvery:numeric('recheck-every',policyDefaults.recheckEvery),switchMargin:numeric('switch-margin',policyDefaults.switchMargin)};
const samples=numeric('samples',96),block=numeric('block',4);
const holdoutSeed=numeric('seed',0x87654321);
if(!Number.isInteger(holdoutSeed)||holdoutSeed<0||holdoutSeed>0xffffffff||holdoutSeed===0x12345678||holdoutSeed===0)
  throw new RangeError('Evaluation seed must be a nonzero u32 distinct from the training seed');
if(!Number.isInteger(samples)||samples<8||samples>256||!Number.isInteger(block)||block<1||block>8||samples%block)
  throw new RangeError('samples must be 8..256 and divisible by block (1..8)');
if([process.env.MTL_DEBUG_LAYER,process.env.MTL_SHADER_VALIDATION].some(v=>v&&v!=='0')) throw new Error('Disable Metal validation for performance');
const root=fileURLToPath(new URL('../',import.meta.url)),directory=await mkdtemp(`${root}build/fit-`);
const profilePath=`${directory}/profile.json`,outputPath=resolve(values.output??`${root}build/fit-benchmark.json`);
const paths=['native/contract.h','native/buffers.h','native/workloads_runtime.h','native/workloads_cpu.h','native/workloads_plan.h',
  'native/workload-worker.mm','native/workloads.metal','scripts/build.mjs','src/adaptive.ts','src/adaptive-worker.ts',
  'src/adaptive-policy.ts','src/adaptive-profile.ts','src/contract.ts','src/schema.ts','src/workload-spec.ts','src/fit.ts','src/fit-cases.ts','scripts/bench-fit.ts'];
const hashes=async()=>Object.fromEntries(await Promise.all(paths.map(async p=>[p,createHash('sha256').update(await readFile(`${root}${p}`)).digest('hex')])));
const sourceHashes=await hashes();
let scheduler=await AdaptiveScheduler.open({...policy,profilePath});
const info=scheduler.info,cases=[],replays=[];
const sample=(result:AdaptiveResult,apiUs:number):FitSample=>({mode:result.mode,reason:result.decision.reason,serviceUs:result.serviceUs,apiUs});
try {
  for(const definition of fitCases) {
    const trainingInput=await scheduler.prepare(definition.spec,{inputPlacement:definition.placement});
    const modes:WorkloadMode[]=['cpu-serial','cpu-parallel',definition.placement==='resident'?'gpu-resident':'gpu-upload'];
    // Warm each candidate equally. These measurements never train the policy.
    for(const mode of modes) await scheduler.run(trainingInput,{mode,learn:false});
    const start=performance.now(),training=[];
    for(let i=0;i<policy.minSamples*modes.length;i++) training.push(await scheduler.run(trainingInput));
    const trainingUs=(performance.now()-start)*1000,trained=scheduler.profile(trainingInput);
    assert.ok(trained.trained,'ordinary run calls must train every candidate');
    const originalKey=trainingInput.profileKey,trainingHash=trainingInput.inputHash;
    await scheduler.release(trainingInput);
    // Different immutable data, same shape. Reference controls never update it.
    const heldSpec={...definition.spec,seed:holdoutSeed};
    const handle=await scheduler.prepare(heldSpec,{inputPlacement:definition.placement});
    assert.equal(handle.profileKey,originalKey);
    // A fully hot histogram is deliberately constant, independent of seed.
    if(definition.spec.distribution!=='hot') assert.notEqual(handle.inputHash,trainingHash);
    const variants=[...modes,'auto'] as const;
    const evaluations:{round:number;variant:string;apiUs:number;result:AdaptiveResult}[]=[];
    for(let round=0;round<samples/block;round++) for(let order=0;order<variants.length;order++) {
      const variant=variants[(round+order)%variants.length];
      for(let i=0;i<block;i++) {
        const before=performance.now(),result=await scheduler.run(handle,variant==='auto'?{}:{mode:variant,learn:false});
        const apiUs=(performance.now()-before)*1000;
        assert.ok(result.verified);
        if(evaluations.length) { assert.equal(result.checksum,evaluations[0].result.checksum);assert.equal(result.resultCount,evaluations[0].result.resultCount); }
        evaluations.push({round,variant,apiUs,result});
      }
    }
    const controls=evaluations.filter(r=>r.variant!=='auto').map(r=>sample(r.result,r.apiUs));
    const automatic=evaluations.filter(r=>r.variant==='auto').map(r=>sample(r.result,r.apiUs));
    const assessment=assessFit(controls,automatic),apiBest=Math.min(...Object.values(assessment.controls).map(s=>s!.apiP50Us));
    const checks={fit:assessment.steadyCount>=samples*.8&&assessment.steadyFitRate>=.9,
      regret:assessment.estimatedRegret<=.15,latency:assessment.autoApiP50Us<=apiBest*1.25+20};
    const profile=scheduler.profile(handle);
    cases.push({...definition,trainingHash,inputHash:handle.inputHash,profileKey:handle.profileKey,
      heldInputChanged:handle.inputHash!==trainingHash,
      prepareUs:trainingInput.prepareUs+handle.prepareUs,reservedBytes:handle.reservedBytes,trainingUs,training,trained,
      evaluations,assessment,checks,profile});
    console.log(`${definition.name}: ${assessment.family}, fit ${(100*assessment.steadyFitRate).toFixed(1)}%, API ${assessment.autoApiP50Us.toFixed(1)} us, ${Object.values(checks).every(Boolean)?'PASS':'FAIL'}`);
    await scheduler.release(handle);
  }
  await scheduler.flush();const savedProfile=JSON.parse(await readFile(profilePath,'utf8'));
  await scheduler.close();scheduler=await AdaptiveScheduler.open({...policy,profilePath});
  assert.equal(scheduler.info.profileStatus,'loaded');
  for(const family of ['cpu','gpu']) {
    const c=cases.find(c=>c.assessment.family===family);if(!c) continue;
    const h=await scheduler.prepare({...c.spec,seed:17},{inputPlacement:c.placement});
    const profile=scheduler.profile(h);assert.ok(profile.trained);
    const result=await scheduler.run(h);assert.ok(result.verified);
    replays.push({name:c.name,family,profileStatus:scheduler.info.profileStatus,profile,result});
    await scheduler.release(h);
  }
  const coverage={cpu:cases.filter(c=>c.assessment.family==='cpu').length,gpu:cases.filter(c=>c.assessment.family==='gpu').length,
    ambiguous:cases.filter(c=>c.assessment.family==='ambiguous').length};
  const passed=coverage.cpu>0&&coverage.gpu>0&&cases.every(c=>Object.values(c.checks).every(Boolean));
  assert.deepEqual(await hashes(),sourceHashes,'sources changed during measurement');
  const output={measuredAt:new Date().toISOString(),sourceHashes,policy,samples,block,holdoutSeed,info,
    macOS:execFileSync('sw_vers',['-productVersion'],{encoding:'utf8'}).trim(),node:process.version,
    thresholds:{relativeTolerance:.1,absoluteToleranceUs:10,steadyFitRate:.9,estimatedRegret:.15,apiRelativeSlowdown:1.25,apiAbsoluteOverheadUs:20},
    notes:[
      'Suitability hypotheses never enter the scheduler. Require measured clear CPU and GPU winners; ambiguous cases do not count as either.',
      'CPU TEA uses four-block NEON arithmetic and GCD; pointer chase is a single dependent cycle on both backends.',
      'One excluded warmup per candidate, then ordinary automatic runs train each candidate minSamples times.',
      'Training and holdout use different seeds and actual input hashes, except the intentionally constant hot histogram. Forced reference controls use learn=false.',
      'Serial requests in rotating blocks model a repeated workload. No scheduler queue contention is present.',
      'Fit compares selected modes with held-out service medians within 10% plus 10 us; clear family additionally requires separated interquartile ranges.',
      'Regret is estimated from reference mode medians, includes exploration and is not a simultaneous counterfactual measurement.',
      'API slowdown compares public call-to-completion medians. Training, preparation and startup are separate. Full verification/IPC remain included.',
      'OS load, power and GPU frequency are uncontrolled. Gate failures are evidence to inspect, not permission to relabel a slow candidate.',
    ],coverage,passed,cases,replays,savedProfile};
  await mkdir(dirname(outputPath),{recursive:true});
  await writeFile(outputPath,JSON.stringify(output,null,2)+'\n',{flag:values.output?'wx':'w'});
  console.table(cases.map(c=>({case:c.name,measured:c.assessment.family,selected:c.profile.preferred,
    'fit %':+(c.assessment.steadyFitRate*100).toFixed(1),'regret %':+(c.assessment.estimatedRegret*100).toFixed(1),
    'API ratio':+c.assessment.apiSlowdown.toFixed(2),'learn ms':+(c.trainingUs/1000).toFixed(2),pass:Object.values(c.checks).every(Boolean)})));
  console.log(`Fit gate: ${passed?'PASS':'FAIL'}; measured coverage ${JSON.stringify(coverage)}; ${outputPath}`);
  if(!passed) process.exitCode=1;
} finally { await scheduler.close(); }
