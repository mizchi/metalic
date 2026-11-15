import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProfile,saveProfile } from '../src/adaptive-profile.ts';
test('profile cache rejects corrupt, incompatible, expired and nonfinite observations',async()=> {
  const directory=await mkdtemp(join(tmpdir(),'metalic-profile-')),path=join(directory,'profile.json');
  try {
    assert.equal((await loadProfile(path,'build',10000)).status,'new');
    await writeFile(path,'broken'); assert.equal((await loadProfile(path,'build',10000)).status,'invalid');
    await saveProfile(path,'build',{}); assert.equal((await loadProfile(path,'build',10000)).status,'loaded');
    assert.equal((await loadProfile(path,'other',10000)).status,'incompatible');
    const data=JSON.parse(await readFile(path,'utf8')); data.savedAt=Date.now()-20000;
    await writeFile(path,JSON.stringify(data)); assert.equal((await loadProfile(path,'build',10000)).status,'expired');
    data.savedAt=Date.now();data.profiles={job:{incumbent:'cpu-serial',decisions:0,modes:{'cpu-serial':{lastUsed:1,
      samples:[{us:null,contended:false,at:Date.now()}]}}}};
    await writeFile(path,JSON.stringify(data)); assert.equal((await loadProfile(path,'build',10000)).status,'invalid');
  } finally { await rm(directory,{recursive:true,force:true}); }
});
