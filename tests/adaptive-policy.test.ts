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
