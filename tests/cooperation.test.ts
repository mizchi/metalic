import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseModuleReference } from '../src/module-reference.ts';
import { parseReference } from '../src/reference.ts';
import type { GpuModuleResult } from '../src/contract.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
interface Experimental extends GpuModuleResult {
  feedbackEvery: number; feedbackWaits: number; dispatchSignature: string;
  feedbackSamples: {dispatches:number;tokenCount:number;nodeCount:number;gpuUs:number;elapsedUs:number;readUs:number}[];
}
test('isolated feedback checkpoints preserve kernel plans, results and diagnostics',()=> {
  for(const [language,sources,oracle] of [
    ['module',['fn f(x:u32):u32{(x+1)*3}','fn f():u32{missing}','fn f(x:str):u32{x}',
      '','fn f():str{"日本語"}'],parseModuleReference],
    ['expression',['(a+b)*c','/* bad','"日本語"','1+'.repeat(2048)+'1'],parseReference],
  ] as const) {
    const variants=[0,8,1].map(feedbackEvery=>JSON.parse(execFileSync(`${root}build/frontend-feedback`,[`${root}native`],{
      input:JSON.stringify({sources,language,feedbackEvery,maxInFlight:3,poisonBuffers:true}),
      encoding:'utf8',maxBuffer:32*1024*1024,
    })) as Experimental[]);
    for(const results of variants) results.forEach((actual,i)=> {
      const expected=oracle(sources[i]);
      assert.deepEqual(actual.tokens,expected.tokens);
      assert.deepEqual(actual.nodes,expected.nodes);
      assert.deepEqual(actual.diagnostic,expected.diagnostic);
      if('functions' in expected) assert.deepEqual(actual.functions,expected.functions);
      assert.equal(actual.dispatches,variants[0][i].dispatches);
      assert.equal(actual.dispatchSignature,variants[0][i].dispatchSignature);
      assert.equal(actual.feedbackWaits,actual.feedbackEvery ? Math.floor((actual.dispatches-1)/actual.feedbackEvery) : 0);
      assert.equal(actual.hostWaits,actual.feedbackWaits+1);
      assert.equal(actual.feedbackSamples.length,actual.feedbackWaits);
      actual.feedbackSamples.forEach((sample,j)=> {
        assert.equal(sample.dispatches,(j+1)*actual.feedbackEvery);
        assert.ok(sample.tokenCount<=Buffer.byteLength(sources[i]));
        assert.ok(sample.nodeCount<=sample.tokenCount);
      });
    });
  }
});

test('production binary rejects benchmark-only feedback controls',()=> {
  const result=spawnSync(`${root}build/frontend-metal`,[`${root}native`],{
    input:JSON.stringify({sources:['1'],feedbackEvery:1}),encoding:'utf8',
  });
  assert.equal(result.status,1);
  assert.match(result.stderr,/benchmark.only/);
});
