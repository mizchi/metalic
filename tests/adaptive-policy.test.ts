import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptivePolicy } from '../src/adaptive-policy.ts';
import type { WorkloadMode } from '../src/contract.ts';
const modes:WorkloadMode[]=['cpu-serial','cpu-parallel','gpu-upload'];
const idle={cpu:0,gpu:0};

test('policy samples every candidate before committing to a faster backend',()=> {
  const p=new AdaptivePolicy({minSamples:3,recheckEvery:16,window:9,switchMargin:.1});
  const counts=new Map<WorkloadMode,number>();
  for(let i=0;i<9;i++) {
    const d=p.select('job',modes,idle);
    p.started('job',d.mode);
    counts.set(d.mode,(counts.get(d.mode)??0)+1);
    p.observe('job',d.mode,{'cpu-serial':100,'cpu-parallel':60,'gpu-upload':20,'gpu-resident':20}[d.mode],false);
  }
  assert.deepEqual([...counts.values()],[3,3,3]);
  assert.equal(p.select('job',modes,idle).mode,'gpu-upload');
});

test('queue estimates can place independent work on the other processor',()=> {
  const p=new AdaptivePolicy({minSamples:3});
  for(let i=0;i<3;i++) for(const mode of modes)
    p.observe('job',mode,mode==='gpu-upload' ? 20 : mode==='cpu-parallel' ? 50 : 100,false);
  const d=p.select('job',modes,{cpu:0,gpu:1000});
  assert.equal(d.mode,'cpu-parallel'); assert.equal(d.reason,'queue');
  assert.equal(p.select('job',modes,idle).mode,'gpu-upload');
});

test('noise margin avoids switching for a small apparent improvement',()=> {
  const p=new AdaptivePolicy({minSamples:3,switchMargin:.1});
  for(let i=0;i<3;i++) for(const mode of modes) p.observe('job',mode,mode==='cpu-serial' ? 100 : mode==='cpu-parallel' ? 95 : 200,false);
  assert.equal(p.select('job',modes,idle).mode,'cpu-serial');
});

test('periodic exploration adapts to changed performance without unbounded history',()=> {
  const p=new AdaptivePolicy({minSamples:3,recheckEvery:6,window:5});
  for(let i=0;i<3;i++) for(const mode of modes) p.observe('job',mode,mode==='gpu-upload' ? 200 : 100,false);
  for(let i=0;i<80;i++) {
    const d=p.select('job',modes,idle); p.started('job',d.mode);
    p.observe('job',d.mode,d.mode==='gpu-upload' ? 10 : 100,false);
  }
  assert.equal(p.select('job',modes,idle).preferred,'gpu-upload');
  for(const stats of Object.values(p.snapshot().job.modes)) assert.ok(stats!.samples.length<=5);
});

test('overlap samples do not erase a measured isolated cost',()=> {
  const p=new AdaptivePolicy({minSamples:3});
  for(let i=0;i<3;i++) {
    for(const mode of modes) p.observe('job',mode,mode==='gpu-upload' ? 20 : 100,false);
    for(const mode of modes) p.observe('job',mode,mode==='gpu-upload' ? 400 : 100,true);
  }
  assert.equal(p.select('job',modes,idle).mode,'gpu-upload');
  assert.equal(p.select('job',modes,idle,true).mode,'cpu-serial');
});

test('an incumbent speed change promptly rechecks a stale competing processor',()=> {
  // Regression from fit trial 2: calibration CPU 17 ms / GPU 20 ms, then
  // CPU 12 ms / GPU 5.4 ms. Sparse probes left the GPU median stale for 96 jobs.
  const p=new AdaptivePolicy({minSamples:5,window:9,recheckEvery:16});
  for(let i=0;i<5;i++) for(const m of modes) p.observe('job',m,m==='gpu-upload'?20000:m==='cpu-parallel'?17000:100000,false);
  const selected:WorkloadMode[]=[];
  for(let i=0;i<20;i++) {
    const d=p.select('job',modes,idle);selected.push(d.mode);p.started('job',d.mode);
    p.observe('job',d.mode,d.mode==='gpu-upload'?5400:d.mode==='cpu-parallel'?12000:93000,false);
  }
  assert.equal(p.select('job',modes,idle).preferred,'gpu-upload');
  assert.ok(selected.slice(-8).every(m=>m==='gpu-upload'));
});

test('a much faster probe is confirmed promptly instead of waiting for isolated medians to age out',()=> {
  const p=new AdaptivePolicy({minSamples:3,window:9,recheckEvery:6});
  for(let i=0;i<9;i++) for(const m of modes) p.observe('job',m,m==='gpu-upload'?200:100,false);
  for(let i=0;i<24;i++) {
    const d=p.select('job',modes,idle);p.started('job',d.mode);
    p.observe('job',d.mode,d.mode==='gpu-upload'?10:100,false);
  }
  assert.equal(p.select('job',modes,idle).preferred,'gpu-upload');
});

test('one unusually fast probe does not replace a stable cost model',()=> {
  const p=new AdaptivePolicy({minSamples:3,window:9,recheckEvery:6});
  for(let i=0;i<9;i++) for(const m of modes) p.observe('job',m,m==='gpu-upload'?200:100,false);
  p.observe('job','gpu-upload',10,false);
  const probe=p.select('job',modes,idle);assert.equal(probe.mode,'gpu-upload');assert.equal(probe.reason,'explore');
  p.started('job',probe.mode);p.observe('job',probe.mode,200,false);
  assert.equal(p.select('job',modes,idle).preferred,'cpu-serial');
  assert.equal(p.estimate('job','gpu-upload'),200);
});

test('probe confirmations stay in their observed contention context',()=> {
  const p=new AdaptivePolicy({minSamples:3,window:9});
  for(let i=0;i<9;i++) for(const contended of [false,true]) for(const m of modes)
    p.observe('job',m,m==='gpu-upload'?200:100,contended);
  p.observe('job','gpu-upload',10,true);
  assert.equal(p.select('job',modes,idle,false).mode,'cpu-serial');
  assert.equal(p.select('job',modes,idle,true).mode,'gpu-upload');
});
