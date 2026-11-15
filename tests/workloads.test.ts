import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runWorkloads } from '../src/workloads.ts';
import type { WorkloadSpec } from '../src/contract.ts';

function input(job: WorkloadSpec): Buffer {
  let state=job.seed??0x12345678;
  const next=()=> { state^=state<<13; state^=state>>>17; state^=state<<5; return state>>>0; };
  const bytes=Buffer.alloc(job.count*(job.algorithm==='merkle-sha256' ? 64 : job.algorithm==='compact-u32' ? 4 : 1));
  if(job.algorithm==='compact-u32') for(let i=0;i<job.count;i++) bytes.writeUInt32LE(next(),i*4);
  else for(let i=0;i<bytes.length;i++) bytes[i]=job.distribution==='hot' ? 7 : next()&255;
  return bytes;
}
function digest(bytes: Buffer): Buffer { return createHash('sha256').update(bytes).digest(); }
function merkle(bytes:Buffer):string {
  let level=Array.from({length:bytes.length/64},(_,i)=>digest(bytes.subarray(i*64,i*64+64)));
  if(!level.length) return digest(Buffer.alloc(0)).toString('hex');
  while(level.length>1) level=Array.from({length:Math.ceil(level.length/2)},(_,i)=>
    digest(Buffer.concat([level[2*i],level[Math.min(2*i+1,level.length-1)]])));
  return level[0].toString('hex');
}
function checksum(xs:number[]):number {
  let result=0; for(let i=0;i<xs.length;i++) result=(result+Math.imul(xs[i]^0x9e3779b9,i+1))>>>0;
  return result;
}

test('SHA-256 Merkle roots match node:crypto including empty, odd and multi-level trees',()=> {
  const jobs=[0,1,2,3,37,257].map(count=>({algorithm:'merkle-sha256',count,seed:count===1 ? 0 : 0x12345678}) as const);
  const result=runWorkloads(jobs,{warmups:0,samples:1,poisonBuffers:true});
  assert.equal(result.mslVersion,'4.0'); assert.equal(result.records.length,jobs.length*4);
  result.records.forEach((r,i)=> {
    const bytes=input(jobs[Math.floor(i/4)]);
    assert.equal(r.digestHex,merkle(bytes)); assert.equal(r.verified,true);
    assert.equal(r.inputHash,digest(bytes).toString('hex'));
  });
});

test('histograms match independent counts for irregular, uniform and contended distributions',()=> {
  const jobs=[257,0,1,255,256,4097,7].flatMap(count=>['uniform','hot'].map(distribution=>
    ({algorithm:'histogram256',count,distribution}) as WorkloadSpec));
  const result=runWorkloads(jobs,{warmups:0,samples:1,poisonBuffers:true,includeOutput:true});
  result.records.forEach((r,i)=> {
    const expected=new Array<number>(256).fill(0);
    for(const byte of input(jobs[Math.floor(i/4)])) expected[byte]++;
    assert.deepEqual(r.output,expected); assert.equal(r.checksum,checksum(expected));
    assert.equal(r.verified,true);
    if(r.mode.startsWith('gpu')) assert.equal(r.hostWaits,1);
  });
});

test('stable compaction preserves order across scan levels and all/none selections',()=> {
  const jobs:WorkloadSpec[]=[8191,0,1,255,256,257,513,17].map(count=>({algorithm:'compact-u32',count}));
  jobs.push({algorithm:'compact-u32',count:513,mask:0},{algorithm:'compact-u32',count:513,mask:0xffffffff},
    {algorithm:'compact-u32',count:513,seed:0});
  const result=runWorkloads(jobs,{warmups:0,samples:1,poisonBuffers:true,includeOutput:true});
  result.records.forEach((r,i)=> {
    const job=jobs[Math.floor(i/4)],bytes=input(job),expected=[];
    for(let j=0;j<job.count;j++) { const v=bytes.readUInt32LE(j*4); if((v&(job.mask??1))===0) expected.push(v); }
    assert.deepEqual(r.output,expected); assert.equal(r.resultCount,expected.length);
    assert.equal(r.checksum,checksum(expected)); assert.equal(r.verified,true);
  });
  const largeJobs:WorkloadSpec[]=[{algorithm:'compact-u32',count:65537},
    {algorithm:'compact-u32',count:65537,mask:0xffffffff},{algorithm:'compact-u32',count:65537,seed:0}];
  const largeResults=runWorkloads(largeJobs,{warmups:0,samples:2,poisonBuffers:true}).records;
  largeResults.forEach((large,i)=> {
    const job=largeJobs[Math.floor(i/4)],data=input(job),values=[];
    for(let j=0;j<job.count;j++) { const v=data.readUInt32LE(4*j); if((v&(job.mask??1))===0) values.push(v); }
    assert.equal(large.verified,true);
    if(large.mode.startsWith('gpu')) assert.equal(large.hostWaits,1);
    assert.equal(large.resultCount,values.length); assert.equal(large.checksum,checksum(values));
  });
});

test('workload contracts reject invalid input before native execution',()=> {
  for(const count of [-1,1.5,NaN,Infinity,2**32])
    assert.throws(()=>runWorkloads([{algorithm:'compact-u32',count}]),RangeError);
  assert.throws(()=>runWorkloads([{algorithm:'unknown' as 'compact-u32',count:1}]),TypeError);
  assert.throws(()=>runWorkloads([{algorithm:'histogram256',count:1}],{samples:0}),RangeError);
  assert.throws(()=>runWorkloads([{algorithm:'compact-u32',count:8193}],{includeOutput:true}),RangeError);
});
