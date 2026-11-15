import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessFit } from '../src/fit.ts';
import type { FitSample,WorkloadMode } from '../src/contract.ts';
const samples=(mode:WorkloadMode,us:number):FitSample[]=>Array.from({length:9},()=>({mode,serviceUs:us,apiUs:us+5}));

test('fit assessment distinguishes clear CPU/GPU winners and admits close CPU variants',()=> {
  const controls=[...samples('cpu-serial',105),...samples('cpu-parallel',100),...samples('gpu-upload',400)];
  const fit=assessFit(controls,samples('cpu-serial',105));
  assert.equal(fit.family,'cpu');assert.equal(fit.referenceMode,'cpu-parallel');
  assert.equal(fit.fitRate,1);assert.ok(fit.competitive.includes('cpu-serial'));
  const wrong=assessFit(controls,samples('gpu-upload',400));
  assert.equal(wrong.fitRate,0);assert.equal(wrong.estimatedRegret,3);
  assert.equal(assessFit([...samples('cpu-serial',400),...samples('gpu-resident',100)],samples('gpu-resident',100)).family,'gpu');
});

test('fit assessment reports ambiguous distributions and does not hide exploration cost',()=> {
  const controls=[...samples('cpu-serial',100),...samples('gpu-upload',102)];
  assert.equal(assessFit(controls,samples('cpu-serial',100)).family,'ambiguous');
  const mixed=[...samples('cpu-serial',100),{mode:'gpu-upload' as const,serviceUs:500,apiUs:505,reason:'explore' as const}];
  const fit=assessFit([...samples('cpu-serial',100),...samples('gpu-upload',500)],mixed);
  assert.equal(fit.fitRate,.9);assert.equal(fit.steadyFitRate,1);assert.ok(fit.estimatedRegret>0);
  assert.throws(()=>assessFit(controls,[{mode:'cpu-serial',serviceUs:NaN,apiUs:2}]),/finite/);
  assert.throws(()=>assessFit(samples('cpu-serial',100),samples('cpu-serial',100)),/CPU and GPU/);
  const noisy=[20,30,40,60,65,75,150,160,200].map(us=>({mode:'gpu-upload' as const,serviceUs:us,apiUs:us+5}));
  assert.equal(assessFit([...samples('cpu-serial',100),...noisy],samples('cpu-serial',100)).family,'ambiguous');
});
