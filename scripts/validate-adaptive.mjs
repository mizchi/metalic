import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdaptiveScheduler } from '../src/adaptive.ts';

const directory=await mkdtemp(join(tmpdir(),'metalic-adaptive-validation-'));
const scheduler=await AdaptiveScheduler.open({profilePath:join(directory,'profile.json'),poisonBuffers:true,minSamples:1});
let executions=0;
try {
  const jobs=[{algorithm:'merkle-sha256',count:257},{algorithm:'histogram256',count:257,distribution:'hot'},
    {algorithm:'compact-u32',count:65537},{algorithm:'compact-u32',count:0}];
  const handles=[];
  for(const job of jobs) handles.push(await scheduler.prepare(job));
  for(const h of handles) {
    const calibration=await scheduler.calibrate(h,1);
    assert.ok(calibration.every(r=>r.verified)); executions+=2; // GPU warmup + measured run.
    const [cpu,gpu]=await Promise.all([scheduler.run(h,{mode:'cpu-serial'}),scheduler.run(h,{mode:'gpu-upload'})]);
    assert.equal(cpu.checksum,gpu.checksum); assert.equal(cpu.resultCount,gpu.resultCount);
    executions++;
    await scheduler.release(h);
  }
} finally { await scheduler.close(); await rm(directory,{recursive:true,force:true}); }
// Metal validation can write diagnostics without making the command buffer fail.
for(const [lane,stderr] of Object.entries(scheduler.diagnostics()))
  assert.doesNotMatch(stderr,/error|fault|out.of.bounds|invalid (?:access|resource)/i,`${lane}: ${stderr}`);
console.log(`Adaptive Metal validation: ${executions} GPU executions, persistent workers, poisoned buffers, all results verified`);
