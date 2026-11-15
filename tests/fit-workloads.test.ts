import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runWorkloads } from '../src/workloads.ts';
import type { WorkloadSpec } from '../src/contract.ts';

function fixture(spec:WorkloadSpec) {
  let state=spec.seed??0x12345678;
  const next=()=> { state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0; };
  const data=new Uint32Array(spec.count*(spec.algorithm==='tea32'?2:1));
  if(spec.algorithm==='tea32') for(let i=0;i<data.length;i++) data[i]=next();
  else for(let i=1;i<spec.count;i++) { const at=next()%i;data[i]=data[at];data[at]=i; }
  return data;
}
function tea(input:Uint32Array):number[] {
  const output=[];
  for(let i=0;i<input.length;i+=2) {
    let y=input[i],z=input[i+1],sum=0;
    for(let round=0;round<32;round++) {
      sum=(sum+0x9e3779b9)>>>0;
      y=(y+((z<<4)^((z+sum)>>>0)^(z>>>5)))>>>0;
      z=(z+((y<<4)^((y+sum)>>>0)^(y>>>5)))>>>0;
    }
    output.push(y,z);
  }
  return output;
}
function chase(input:Uint32Array):number[] {
  let at=0,hash=2166136261;
  for(let step=0;step<input.length;step++) { at=input[at];hash=Math.imul(hash^at,16777619)>>>0; }
  return [at,hash];
}

test('TEA32 scalar, CPU SIMD/GCD and MSL match an independent 32-cycle oracle',()=> {
  assert.deepEqual(tea(new Uint32Array(2)),[0x41ea3a0a,0x94baa940]);
  const jobs:WorkloadSpec[]=[0,1,3,255,256,257,4095].map(count=>({algorithm:'tea32',count}));
  jobs.push({algorithm:'tea32',count:1,seed:0});
  const results=runWorkloads(jobs,{warmups:0,samples:1,includeOutput:true,poisonBuffers:true});
  for(const [i,r] of results.records.entries()) {
    const input=fixture(jobs[Math.floor(i/4)]),expected=tea(input);
    assert.deepEqual(r.output,expected);assert.equal(r.resultCount,expected.length);
    assert.equal(r.inputHash,createHash('sha256').update(input).digest('hex'));assert.ok(r.verified);
  }
  assert.throws(()=>runWorkloads([{algorithm:'tea32',count:4097}],{includeOutput:true}),/8192/);
});

test('single-cycle pointer chase preserves dependent loads on CPU and GPU, including empty input',()=> {
  const jobs:WorkloadSpec[]=[0,1,3,255,256,257,4097].map(count=>({algorithm:'pointer-chase',count}));
  jobs.push({algorithm:'pointer-chase',count:257,seed:0});
  const results=runWorkloads(jobs,{warmups:0,samples:1,includeOutput:true,poisonBuffers:true});
  for(const [i,r] of results.records.entries()) {
    const input=fixture(jobs[Math.floor(i/4)]);
    assert.deepEqual(r.output,chase(input));assert.equal(r.resultCount,2);assert.ok(r.verified);
    assert.equal(r.inputHash,createHash('sha256').update(input).digest('hex'));
    if(r.mode.startsWith('cpu')) assert.equal(r.cpuTasks,1);
  }
  assert.throws(()=>runWorkloads([{algorithm:'pointer-chase',count:65537}]),RangeError);
});
