import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseGpuBatch, parseGpuModules } from '../src/gpu.ts';
import { parseReference } from '../src/reference.ts';
import { parseModuleReference } from '../src/module-reference.ts';
import type { GpuModuleResult } from '../src/contract.ts';

const modes=['fresh','reuse','selective'] as const;
const large=Array.from({length:128},(_,i)=>`fn f${i}(x:u32):u32{(x+${i})*3}`).join('\n');

test('buffer reuse preserves long-to-short, error-to-success and empty transitions',()=> {
  const sources=[large,'fn f():u32{1}','fn f():str{missing}', '',
    'fn f(x:str):str{x+1}','fn f(x:str):str{x}',large,'fn f():str{"日本語"}'];
  for(const buffers of modes) {
    const results=parseGpuModules(sources,7,1,{buffers,poisonBuffers:true});
    assert.equal(results.length,sources.length);
    results.forEach((actual,i)=> {
      const expected=parseModuleReference(sources[i]);
      assert.deepEqual(actual.tokens,expected.tokens);
      assert.deepEqual(actual.nodes,expected.nodes);
      assert.deepEqual(actual.functions,expected.functions);
      assert.deepEqual(actual.diagnostic,expected.diagnostic,sources[i].slice(0,60));
      assert.equal(actual.buffers,buffers);
      assert.equal(actual.hostWaits,1);
      assert.equal(actual.mslVersion,'4.0');
      assert.ok(actual.arenaCapacityBytes>=actual.arenaBytes);
      const t=actual.timingsUs;
      assert.ok(Math.abs(t.prepareUs+t.acquireUs+t.initializeUs+t.encodeUs+t.submitWaitUs-actual.elapsedUs)<.001);
    });
    assert.equal(results[0].bufferAllocations,2);
    assert.equal(results[1].bufferAllocations,buffers==='fresh' ? 2 : 0);
  }
});

test('selective initialization covers empty and lexer boundary cases with poisoned memory',()=> {
  const sources=['1+'.repeat(40000)+'1','', ' ', '/* missing', '"missing',
    'name', '4294967296', '"日本語"', '(a+b)*c', '@'.repeat(4097),'1'];
  for(const diagnostics of ['tree','hierarchical','packed'] as const) {
    const results=parseGpuBatch(sources,16,1,{buffers:'selective',diagnostics,poisonBuffers:true});
    results.forEach((actual,i)=> {
      const expected=parseReference(sources[i]);
      assert.deepEqual(actual.tokens,expected.tokens);
      assert.deepEqual(actual.nodes,expected.nodes);
      assert.equal(actual.root,expected.root);
      assert.deepEqual(actual.diagnostic,expected.diagnostic);
    });
  }
});

test('warm reuse allocates no new buffers and selective resets fewer bytes',()=> {
  const results=modes.map(buffers=>parseGpuModules([large],64,4,{buffers})[0]);
  for(const [i,actual] of results.entries()) {
    assert.deepEqual(actual.allocationSamples,i===0 ? [2,2,2,2] : [2,0,0,0]);
    assert.equal(actual.timingSamplesUs.length,4);
  }
  assert.ok(results[2].initializedBytes<results[1].initializedBytes/2);
  assert.deepEqual(results[2].nodes,results[0].nodes);
  for(const buffers of ['reuse','selective'] as const) {
    const sources=['1','1+'.repeat(40000)+'1','1'];
    const resized=parseGpuBatch(sources,64,1,{buffers,poisonBuffers:true});
    resized.forEach((actual,i)=>assert.deepEqual(actual.nodes,parseReference(sources[i]).nodes));
    assert.ok(resized[1].bufferAllocations>0);
    assert.equal(resized[2].bufferAllocations,0);
    assert.equal(resized[2].arenaCapacityBytes,resized[1].arenaCapacityBytes);
  }
});

test('pooled buffers tolerate diagnostic layout changes in the native comparison protocol',()=> {
  const root=fileURLToPath(new URL('../',import.meta.url));
  const sources=[large,'fn f():u32{}','fn f():u32{1}'];
  const output=execFileSync(`${root}build/frontend-metal`,[`${root}native`],{
    input:JSON.stringify({sources,language:'module',chunkSize:7,repeat:2,
      diagnostics:['tree','hierarchical','packed'],buffers:modes,poisonBuffers:true}),
    encoding:'utf8',maxBuffer:64*1024*1024,
  });
  const results=JSON.parse(output) as GpuModuleResult[];
  assert.equal(results.length,sources.length*9);
  results.forEach((actual,i)=> {
    const expected=parseModuleReference(sources[Math.floor(i/9)]);
    assert.deepEqual(actual.nodes,expected.nodes);
    assert.deepEqual(actual.functions,expected.functions);
    assert.deepEqual(actual.diagnostic,expected.diagnostic);
  });
});

test('invalid buffer options are rejected before GPU work',()=> {
  assert.throws(()=>parseGpuBatch(['1'],64,1,{buffers:'unknown' as 'fresh'}),TypeError);
  assert.throws(()=>parseGpuBatch(['1'],64,1,{poisonBuffers:1 as unknown as boolean}),TypeError);
});
