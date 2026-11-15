import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdaptiveScheduler } from '../src/adaptive.ts';
import type { AdaptiveResult } from '../src/contract.ts';

test('ordinary executions learn placements without an explicit calibration step',async()=> {
  const directory=await mkdtemp(join(tmpdir(),'metalic-adaptive-'));
  const scheduler=await AdaptiveScheduler.open({profilePath:join(directory,'profile.json'),minSamples:2});
  try {
    const h=await scheduler.prepare({algorithm:'compact-u32',count:4097});
    const results:AdaptiveResult[]=[];
    for(let i=0;i<6;i++) results.push(await scheduler.run(h));
    assert.equal(scheduler.profile(h).trained,true);
    assert.deepEqual(new Set(results.map(r=>r.mode)),new Set(['cpu-serial','cpu-parallel','gpu-upload']));
    assert.ok(results.every(r=>r.verified&&r.checksum===results[0].checksum));
    assert.equal((await scheduler.run(h)).decision.reason==='calibrating',false);
  } finally { await scheduler.close(); await rm(directory,{recursive:true,force:true}); }
});

test('persistent CPU/GPU workers learn, preserve results and restore compatible profiles',async()=> {
  const directory=await mkdtemp(join(tmpdir(),'metalic-adaptive-')),profilePath=join(directory,'profile.json');
  let scheduler=await AdaptiveScheduler.open({profilePath,minSamples:2});
  try {
    const h=await scheduler.prepare({algorithm:'merkle-sha256',count:257});
    const calibration=await scheduler.calibrate(h,2);
    assert.equal(calibration.length,6);
    assert.deepEqual(new Set(calibration.map(r=>r.mode)),new Set(['cpu-serial','cpu-parallel','gpu-upload']));
    assert.ok(calibration.every(r=>r.verified && r.digestHex===calibration[0].digestHex));
    assert.equal(scheduler.profile(h).trained,true);
    const results=await scheduler.runBatch([h,h,h,h,h,h]);
    assert.ok(results.every(r=>r.digestHex===calibration[0].digestHex));
    assert.ok(results.every(r=>r.serviceUs>=0 && r.totalUs>=r.serviceUs && r.queueUs>=0));
    assert.ok([...calibration,...results].every(r=>r.workerPid===(r.mode.startsWith('cpu') ? scheduler.info.cpuPid : scheduler.info.gpuPid)));
    assert.equal(scheduler.info.workerStarts,2);
    await scheduler.flush();
    const stored=JSON.parse(await readFile(profilePath,'utf8'));
    assert.equal(stored.fingerprint,scheduler.info.fingerprint);
    await scheduler.close();
    scheduler=await AdaptiveScheduler.open({profilePath,minSamples:2});
    assert.equal(scheduler.info.profileStatus,'loaded');
    const again=await scheduler.prepare({algorithm:'merkle-sha256',count:257,seed:17});
    assert.equal(scheduler.profile(again).trained,true,'shape profile should survive an immutable input change');
    assert.equal((await scheduler.run(again)).verified,true);
    await scheduler.close();
    stored.fingerprint='old-build'; await writeFile(profilePath,JSON.stringify(stored));
    scheduler=await AdaptiveScheduler.open({profilePath,minSamples:2});
    assert.equal(scheduler.info.profileStatus,'incompatible');
    const fresh=await scheduler.prepare({algorithm:'merkle-sha256',count:257});
    assert.equal(scheduler.profile(fresh).trained,false);
  } finally { await scheduler.close(); await rm(directory,{recursive:true,force:true}); }
});

test('bounded lanes overlap requests and close drains accepted work',async()=> {
  const directory=await mkdtemp(join(tmpdir(),'metalic-adaptive-'));
  const scheduler=await AdaptiveScheduler.open({profilePath:join(directory,'profile.json'),maxPending:2});
  try {
    const h=await scheduler.prepare({algorithm:'merkle-sha256',count:16384});
    const cpu=scheduler.run(h,{mode:'cpu-serial',learn:false});
    const gpu=scheduler.run(h,{mode:'gpu-upload',learn:false});
    assert.throws(()=>scheduler.run(h),/capacity/);
    const closing=scheduler.close();
    assert.throws(()=>scheduler.run(h),/closed/);
    const results=await Promise.all([cpu,gpu]); await closing;
    assert.ok(results.every(r=>r.contended));
    assert.equal(results[0].digestHex,results[1].digestHex);
  } finally { await scheduler.close(); await rm(directory,{recursive:true,force:true}); }
});

test('input placement, distribution features, admission and released handles are enforced',async()=> {
  const directory=await mkdtemp(join(tmpdir(),'metalic-adaptive-'));
  const scheduler=await AdaptiveScheduler.open({profilePath:join(directory,'profile.json'),maxPreparedBytes:8*1024*1024});
  try {
    const cpu=await scheduler.prepare({algorithm:'histogram256',count:257});
    const resident=await scheduler.prepare({algorithm:'histogram256',count:257},{inputPlacement:'resident'});
    const skewed=await scheduler.prepare({algorithm:'histogram256',count:257,seed:0});
    assert.notEqual(cpu.profileKey,resident.profileKey);
    assert.notEqual(cpu.profileKey,skewed.profileKey);
    await assert.rejects(scheduler.prepare({algorithm:'compact-u32',count:16777216}),/budget/i);
    assert.equal((await scheduler.run(resident,{mode:'gpu-resident'})).verified,true);
    assert.throws(()=>scheduler.run(cpu,{mode:'gpu-resident'}),/placement/i);
    const future=scheduler.run(cpu);
    await scheduler.release(cpu); // Must wait for already queued work.
    assert.equal((await future).verified,true);
    assert.throws(()=>scheduler.run(cpu),/released/i);
  } finally { await scheduler.close(); await rm(directory,{recursive:true,force:true}); }
});

test('a failed CPU worker rejects queued work without a hidden GPU retry',async()=> {
  const directory=await mkdtemp(join(tmpdir(),'metalic-adaptive-'));
  const scheduler=await AdaptiveScheduler.open({profilePath:join(directory,'profile.json'),maxPending:2});
  try {
    const h=await scheduler.prepare({algorithm:'compact-u32',count:257});
    process.kill(scheduler.info.cpuPid,'SIGTERM');
    const first=scheduler.run(h,{mode:'cpu-serial'}),second=scheduler.run(h,{mode:'cpu-parallel'});
    await Promise.all([assert.rejects(first,/worker/),assert.rejects(second,/worker/)]);
  } finally { await scheduler.close(); await rm(directory,{recursive:true,force:true}); }
});
