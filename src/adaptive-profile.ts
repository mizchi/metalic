import { readFile, mkdir, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AdaptiveProfiles, AdaptiveEntry, AdaptiveObservation, WorkloadMode } from './contract.ts';
export type ProfileStatus='new'|'loaded'|'incompatible'|'expired'|'invalid';
const modes:WorkloadMode[]=['cpu-serial','cpu-parallel','gpu-upload','gpu-resident'];
const integer=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;

export async function loadProfile(path:string,fingerprint:string,ttl:number):Promise<{status:ProfileStatus;profiles:AdaptiveProfiles}> {
  try {
    if((await stat(path)).size>16*1024*1024) return {status:'invalid',profiles:{}};
    const data=JSON.parse(await readFile(path,'utf8'));
    if(data.schema!==1) return {status:'incompatible',profiles:{}};
    if(data.fingerprint!==fingerprint) return {status:'incompatible',profiles:{}};
    if(!integer(data.savedAt)||data.savedAt>Date.now()+60000) return {status:'invalid',profiles:{}};
    if(Date.now()-data.savedAt>ttl) return {status:'expired',profiles:{}};
    if(!data.profiles || typeof data.profiles!=='object'||Array.isArray(data.profiles)||Object.keys(data.profiles).length>256)
      return {status:'invalid',profiles:{}};
    const profiles:AdaptiveProfiles=Object.create(null);
    for(const [key,value] of Object.entries(data.profiles)) {
      const e=value as AdaptiveEntry;
      if(key.length>1024||!e||!modes.includes(e.incumbent)||!integer(e.decisions)||!e.modes||typeof e.modes!=='object')
        return {status:'invalid',profiles:{}};
      const copy:AdaptiveEntry={incumbent:e.incumbent,decisions:e.decisions,modes:{}};
      for(const [mode,stats] of Object.entries(e.modes)) {
        if(!modes.includes(mode as WorkloadMode)||!stats||!integer(stats.lastUsed)||!Array.isArray(stats.samples)||stats.samples.length>128)
          return {status:'invalid',profiles:{}};
        if(!stats.samples.every((s:AdaptiveObservation)=>s&&Number.isFinite(s.us)&&s.us>0&&typeof s.contended==='boolean'&&integer(s.at)&&s.at<=Date.now()+60000))
          return {status:'invalid',profiles:{}};
        copy.modes[mode as WorkloadMode]={lastUsed:stats.lastUsed,samples:stats.samples.filter(s=>Date.now()-s.at<=ttl)};
      }
      profiles[key]=copy;
    }
    return {status:'loaded',profiles};
  } catch(error) {
    if((error as NodeJS.ErrnoException).code==='ENOENT') return {status:'new',profiles:{}};
    if(error instanceof SyntaxError) return {status:'invalid',profiles:{}};
    throw error;
  }
}
export async function saveProfile(path:string,fingerprint:string,profiles:AdaptiveProfiles):Promise<void> {
  await mkdir(dirname(path),{recursive:true});
  const temp=`${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp,JSON.stringify({schema:1,fingerprint,savedAt:Date.now(),profiles},null,2)+'\n',{flag:'wx',mode:0o600});
    await rename(temp,path);
  } finally { await unlink(temp).catch(e=> { if(e.code!=='ENOENT') throw e; }); }
}
