import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const jobs=[
  ...[0,1,3,257,4097].map(count=>({algorithm:'merkle-sha256',count})),
  ...[0,1,257,4097,1048576].flatMap(count=>['uniform','hot'].map(distribution=>({algorithm:'histogram256',count,distribution}))),
  ...[0,1,255,256,257,65537].map(count=>({algorithm:'compact-u32',count})),
  {algorithm:'compact-u32',count:4097,mask:0},{algorithm:'compact-u32',count:4097,mask:0xffffffff},
  ...[0,1,3,255,256,257,4097].map(count=>({algorithm:'tea32',count})),
  ...[0,1,3,257,4097].map(count=>({algorithm:'pointer-chase',count})),
];
const result=spawnSync(`${root}build/workloads-metal`,[`${root}native`],{
  input:JSON.stringify({jobs,warmups:0,samples:2,poisonBuffers:true}),encoding:'utf8',maxBuffer:16*1024*1024,
  env:{...process.env,MTL_DEBUG_LAYER:'1',MTL_SHADER_VALIDATION:'1'},
});
assert.equal(result.status,0,result.stderr);
assert.doesNotMatch(result.stderr,/error|fault|out.of.bounds|invalid (?:access|resource)/i);
const parsed=JSON.parse(result.stdout);
assert.equal(parsed.records.length,jobs.length*4);
assert.equal(parsed.mslVersion,'4.0');
parsed.records.forEach(r=> { assert.equal(r.verified,true); assert.equal(r.samples.length,2); });
console.log(result.stderr.trim());
console.log(`Metal workload validation: ${jobs.length*4} GPU executions plus CPU controls, poisoned arenas and logical guards, no reported validation errors`);
