import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseGpuBatch, parseGpuModules, checkGpuBatch, checkGpuModules, checkGpuBatchAsync, checkGpuModulesAsync } from '../src/gpu.ts';
import { parseReference } from '../src/reference.ts';
import { parseModuleReference } from '../src/module-reference.ts';
import type { GpuResult, FlightTrace } from '../src/contract.ts';

const large=Array.from({length:128},(_,i)=>`fn f${i}(x:u32):u32{(x+${i})*3}`).join('\n');
const sources=[large,'fn f():u32{1}','fn f():str{missing}','','fn f(x:str):str{x+1}',
  'fn f():str{"日本語"}',large,'fn f():u32{}','fn recovered(x:u32):u32{x+1}'];

function assertLifetimes(results: GpuResult[], maxInFlight: number, repeats=1) {
  const batch=results[0].batch;
  assert.equal(batch.maxInFlight,maxInFlight);
  assert.equal(batch.jobs,results.length*repeats);
  assert.equal(batch.peakLeasedSlots,Math.min(batch.jobs,maxInFlight));
  assert.ok(batch.peakBufferBytes>0);
  const traces=results.flatMap(r=>r.flightSamples).sort((a,b)=>a.sequence-b.sequence);
  assert.equal(traces.length,batch.jobs);
  const slots=new Map<number,FlightTrace>();
  for(const [index,trace] of traces.entries()) {
    assert.equal(trace.sequence,index);
    assert.ok(trace.slot>=0 && trace.slot<maxInFlight);
    assert.ok(trace.prepareBeginUs<=trace.submittedUs);
    assert.ok(trace.submittedUs<=trace.gpuCompletedUs);
    assert.ok(trace.gpuStartedUs===null || typeof trace.gpuStartedUs==='number');
    if(trace.gpuStartedUs!==null && trace.gpuEndedUs!==null) {
      assert.ok(trace.submittedUs<=trace.gpuStartedUs);
      assert.ok(trace.gpuStartedUs<=trace.gpuEndedUs);
      assert.ok(trace.gpuEndedUs<=trace.gpuCompletedUs);
    }
    assert.ok(trace.gpuCompletedUs<=trace.consumeBeginUs);
    assert.ok(trace.consumeBeginUs<=trace.consumeEndUs);
    const previous=slots.get(trace.slot);
    if(previous) assert.ok(previous.consumeEndUs<=trace.prepareBeginUs,'slot reused before CPU consumption ended');
    slots.set(trace.slot,trace);
  }
  if(batch.jobs>=maxInFlight && maxInFlight>1)
    assert.ok(traces[maxInFlight-1].submittedUs<=traces[0].consumeBeginUs,'jobs were serialized before filling the ring');
}

test('bounded flights preserve order and hold poisoned buffers through CPU consumption',()=> {
  for(const maxInFlight of [1,2,3,8]) for(const buffers of ['fresh','reuse','selective'] as const) {
    const results=parseGpuModules(sources,7,2,{maxInFlight,buffers,poisonBuffers:true});
    results.forEach((actual,i)=> {
      const expected=parseModuleReference(sources[i]);
      assert.deepEqual(actual.tokens,expected.tokens);
      assert.deepEqual(actual.nodes,expected.nodes);
      assert.deepEqual(actual.functions,expected.functions);
      assert.deepEqual(actual.diagnostic,expected.diagnostic);
      assert.equal(actual.hostWaits,1);
      assert.equal(actual.mslVersion,'4.0');
    });
    assertLifetimes(results,maxInFlight,2);
  }
});

test('compact checks return validated counts and diagnostics without constructing AST objects',()=> {
  for(const [inputs,parse,check] of [[['1+'.repeat(8192)+'1','','"日本語"','/* bad','(a+b)*c'],parseGpuBatch,checkGpuBatch],
    [sources,parseGpuModules,checkGpuModules]] as const) {
    const full=parse(inputs,16,1,{maxInFlight:3});
    const compact=check(inputs,16,1,{maxInFlight:3,poisonBuffers:true});
    assert.equal(compact.length,full.length);
    compact.forEach((result,i)=> {
      assert.equal(result.output,'summary');
      assert.deepEqual(result.diagnostic,full[i].diagnostic);
      assert.equal(result.valid,full[i].diagnostic===null);
      assert.equal(result.tokenCount,full[i].tokens.length);
      assert.equal(result.nodeCount,full[i].nodes.length);
      assert.equal(result.functionCount,'functions' in full[i] ? (full[i] as {functions:unknown[]}).functions.length : 0);
      assert.ok(!('tokens' in result) && !('nodes' in result) && !('functions' in result));
    });
  }
});

test('multiple flights tolerate diagnostic layouts and reused capacities',()=> {
  const root=fileURLToPath(new URL('../',import.meta.url));
  const result=execFileSync(`${root}build/frontend-metal`,[`${root}native`],{
    input:JSON.stringify({sources,language:'module',repeat:2,maxInFlight:3,
      diagnostics:['tree','hierarchical','packed'],buffers:['reuse','selective'],poisonBuffers:true}),
    encoding:'utf8',maxBuffer:64*1024*1024,
  });
  const results=JSON.parse(result);
  assert.equal(results.length,sources.length*6);
  results.forEach((actual: GpuResult,i: number)=> {
    const expected=parseModuleReference(sources[Math.floor(i/6)]);
    assert.deepEqual(actual.nodes,expected.nodes);
    assert.deepEqual(actual.diagnostic,expected.diagnostic);
  });
  assertLifetimes(results,3,2);
});

test('scheduling options reject invalid bounds before GPU work and handle empty batches',()=> {
  for(const maxInFlight of [0,9,1.5,NaN,Infinity,'3'])
    assert.throws(()=>parseGpuBatch(['1'],64,1,{maxInFlight:maxInFlight as number}),RangeError);
  assert.deepEqual(parseGpuBatch([],64,1,{maxInFlight:3}),[]);
  assert.deepEqual(checkGpuModules([],64,1,{maxInFlight:3}),[]);
  // Expression oracle remains the correctness authority for the ordinary path.
  assert.deepEqual(parseGpuBatch(['1+2'],64,1,{maxInFlight:3})[0].nodes,parseReference('1+2').nodes);
});

test('async checks snapshot inputs while the host can advance its own state',async()=> {
  const inputs=[...sources];
  const future=checkGpuModulesAsync(inputs,7,1,{maxInFlight:3});
  // The host can invalidate its version without changing an in-flight snapshot.
  inputs.fill('fn changed():u32{missing}');
  const results=await future;
  results.forEach((actual,i)=> {
    const expected=parseModuleReference(sources[i]);
    assert.deepEqual(actual.diagnostic,expected.diagnostic);
    assert.equal(actual.nodeCount,expected.nodes.length);
  });
  assert.deepEqual((await checkGpuBatchAsync(['1+2']))[0].diagnostic,null);
  await assert.rejects(checkGpuBatchAsync(['1'],64,1,{maxInFlight:0}),RangeError);
});

test('native protocol rejects invalid scheduling bounds and drains outstanding work on failure',()=> {
  const root=fileURLToPath(new URL('../',import.meta.url));
  for(const maxInFlight of [0,9,1.5,true,'3']) {
    const result=spawnSync(`${root}build/frontend-metal`,[`${root}native`],{
      input:JSON.stringify({sources:['1'],maxInFlight}),encoding:'utf8',
    });
    assert.equal(result.status,1);
    assert.match(result.stderr,/maxInFlight must be 1\.\.8/);
    assert.equal(result.stdout,'');
  }
  const result=spawnSync(`${root}build/frontend-metal`,[`${root}native`],{
    input:JSON.stringify({sources:['1+'.repeat(40000)+'1',false],maxInFlight:3}),encoding:'utf8',
    env:{...process.env,MTL_DEBUG_LAYER:'1',MTL_SHADER_VALIDATION:'1'},
  });
  assert.equal(result.status,1);
  assert.match(result.stderr,/Source must be a string/);
  assert.doesNotMatch(result.stderr,/GPU error|out.of.bounds|invalid (?:access|resource)|fault/i);
  assert.equal(result.stdout,'');
});
