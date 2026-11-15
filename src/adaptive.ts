import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { release, version, arch, totalmem, cpus } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { NativeWorker } from './adaptive-worker.ts';
import { AdaptivePolicy, lane } from './adaptive-policy.ts';
import { loadProfile, saveProfile } from './adaptive-profile.ts';
import { workloadSpec } from './workload-spec.ts';
import type { ProfileStatus } from './adaptive-profile.ts';
import type { WorkloadSpec, WorkloadMode, WorkloadHandle, WorkloadRecord, AdaptiveOptions, AdaptiveDecision, AdaptiveResult } from './contract.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
type Lane='cpu'|'gpu';
interface WorkerInfo { device:string; cpuThreads:number; protocol:number; mslVersion:string; setupUs:number; pid:number }
interface PrepareReply { bytes:number; inputHash:string; feature:string; prepareUs:number }
interface RunReply { record:WorkloadRecord; nativeServiceUs:number; pid:number }
interface HandleState { handle:WorkloadHandle; identity:string; modes:WorkloadMode[]; pending:number; retiring:boolean; waiters:Set<()=>void> }
interface Job {
  state:HandleState; mode?:WorkloadMode; learn:boolean; created:number; contended:boolean;
  resolve:(r:AdaptiveResult)=>void; reject:(e:Error)=>void;
}
interface Active { job:Job; decision:AdaptiveDecision; started:number }
export interface AdaptiveInfo {
  fingerprint:string; profileStatus:ProfileStatus; profilePath:string; workerStarts:number;
  device:string; cpuThreads:number; mslVersion:string; startupUs:number; cpuPid:number; gpuPid:number;
}

/** Placement at pure-region boundaries; running jobs never migrate. */
export class AdaptiveScheduler {
  readonly info:AdaptiveInfo;
  private cpu:NativeWorker; private gpu:NativeWorker; private policy:AdaptivePolicy;
  private maxPending:number; private maxPrepared:number; private maxBytes:number; private poison:boolean;
  private handles=new Map<string,HandleState>(); private reserved=0;
  private queue:Job[]=[]; private jobs=new Set<Job>(); private active:Partial<Record<Lane,Active>>={};
  private idleWaiters=new Set<()=>void>(); private activeWaiters=new Set<()=>void>(); private capacityWaiters=new Set<()=>void>();
  private lifecycle=new Set<Promise<unknown>>(); private maintenance=0; private maintenanceTail=Promise.resolve();
  private closing=false; private closed=false; private closePromise:Promise<void>|undefined; private fatal:Error|undefined;
  private timer:ReturnType<typeof setTimeout>|undefined; private saveTimer:ReturnType<typeof setTimeout>|undefined;
  private writes:Promise<void>=Promise.resolve(); private storageError:Error|undefined; private calibrating=false;

  private constructor(cpu:NativeWorker,gpu:NativeWorker,policy:AdaptivePolicy,options:AdaptiveOptions,info:AdaptiveInfo) {
    this.cpu=cpu; this.gpu=gpu; this.policy=policy; this.info=info;
    this.maxPending=options.maxPending??16; this.maxPrepared=options.maxPrepared??8;
    this.maxBytes=options.maxPreparedBytes??1024*1024*1024; this.poison=options.poisonBuffers??false;
  }
  static async open(options:AdaptiveOptions={}):Promise<AdaptiveScheduler> {
    const start=performance.now();
    // Drop undefined fields before applying defaults.
    const policyOptions=Object.fromEntries(Object.entries(options).filter(([k,v])=>['minSamples','window','recheckEvery','switchMargin'].includes(k)&&v!==undefined));
    const checked=new AdaptivePolicy(policyOptions);
    for(const [value,min,max] of [[options.maxPending??16,1,256],[options.maxPrepared??8,1,64],
      [options.maxPreparedBytes??1073741824,32768,2**40],[options.profileTtlMs??86400000,1,2**40]])
      if(!Number.isSafeInteger(value)||value<min||value>max) throw new RangeError('Invalid scheduler capacity or TTL');
    if(options.poisonBuffers!==undefined&&typeof options.poisonBuffers!=='boolean') throw new TypeError('poisonBuffers must be boolean');
    const cpu=new NativeWorker('cpu'),gpu=new NativeWorker('gpu');
    try {
      const [ci,gi]=await Promise.all([cpu.request<WorkerInfo>('info'),gpu.request<WorkerInfo>('info')]);
      if(ci.protocol!==1||gi.protocol!==1) throw new Error('Unsupported worker protocol');
      const hashes=await Promise.all(['build/workload-worker','native/contract.h','native/workloads.metal','src/adaptive.ts',
        'src/adaptive-worker.ts','src/adaptive-policy.ts','src/adaptive-profile.ts','src/contract.ts','src/workload-spec.ts'].map(async p=>
        createHash('sha256').update(await readFile(`${root}${p}`)).digest('hex')));
      const fingerprint=createHash('sha256').update(JSON.stringify({protocol:1,hashes,device:gi.device,cpu:cpus()[0]?.model,
        threads:ci.cpuThreads,memory:totalmem(),os:release(),build:version(),arch:arch(),node:process.version,v8:process.versions.v8,msl:gi.mslVersion,
        debug:process.env.MTL_DEBUG_LAYER??'',validation:process.env.MTL_SHADER_VALIDATION??'',poison:options.poisonBuffers??false,
        output:'full-buffer+checksum+verify-v1'})).digest('hex');
      const profilePath=resolve(options.profilePath??`${root}build/adaptive-profile.json`);
      const loaded=await loadProfile(profilePath,fingerprint,options.profileTtlMs??86400000);
      return new AdaptiveScheduler(cpu,gpu,new AdaptivePolicy(checked.config,loaded.profiles),options,
        {fingerprint,profilePath,profileStatus:loaded.status,workerStarts:2,device:gi.device,cpuThreads:ci.cpuThreads,
          mslVersion:gi.mslVersion,startupUs:(performance.now()-start)*1000,cpuPid:ci.pid,gpuPid:gi.pid});
    } catch(error) { await Promise.all([cpu.close(),gpu.close()]); throw error; }
  }
  private ready() {
    if(this.closed||this.closing) throw new Error('Scheduler is closed');
    if(this.fatal) throw this.fatal;
  }
  private state(handle:WorkloadHandle,allowRetiring=false):HandleState {
    const state=this.handles.get(handle.id);
    if(!state||state.handle!==handle||(!allowRetiring&&state.retiring)) throw new Error('Workload handle is released or belongs to another scheduler');
    return state;
  }
  private async maintenanceTask<T>(body:()=>Promise<T>):Promise<T> {
    this.maintenance++;
    const task=this.maintenanceTail.then(async()=> { await this.waitActive(); return body(); });
    this.maintenanceTail=task.then(()=>{},()=>{});
    try { return await task; } finally { this.maintenance--; this.pump(); }
  }
  async prepare(spec:WorkloadSpec,options:{inputPlacement?:'cpu'|'resident'}={}):Promise<WorkloadHandle> {
    this.ready(); const canonical=workloadSpec(spec),placement=options.inputPlacement??'cpu';
    if(!['cpu','resident'].includes(placement)) throw new TypeError('Unknown input placement');
    const identity=JSON.stringify([canonical,placement]);
    const cached=[...this.handles.values()].find(s=>s.identity===identity&&!s.retiring);
    if(cached) return cached.handle;
    if(this.jobs.size||this.calibrating) throw new Error('Prepare requires an idle scheduler');
    const task=this.maintenanceTask(async()=> {
      const existing=[...this.handles.values()].find(s=>s.identity===identity&&!s.retiring);
      if(existing) return existing.handle;
      if(this.handles.size>=this.maxPrepared) throw new RangeError('Prepared handle capacity exceeded');
      const start=performance.now();
      const estimates=await Promise.all([this.cpu.request<{bytes:number}>('estimate',{spec:canonical}),this.gpu.request<{bytes:number}>('estimate',{spec:canonical})]);
      const bytes=estimates.reduce((sum,e)=>sum+e.bytes,0);
      if(bytes+this.reserved>this.maxBytes) throw new RangeError('Prepared input exceeds memory budget');
      const id=randomUUID();
      const prepared=await Promise.allSettled([this.cpu.request<PrepareReply>('prepare',{handle:id,spec:canonical,budgetBytes:this.maxBytes}),
        this.gpu.request<PrepareReply>('prepare',{handle:id,spec:canonical,budgetBytes:this.maxBytes})]);
      if(prepared.some(p=>p.status==='rejected')) {
        await Promise.allSettled(prepared.map((p,i)=>p.status==='fulfilled' ? (i===0 ? this.cpu : this.gpu).request('release',{handle:id}) : Promise.resolve()));
        const rejected=prepared.find(p=>p.status==='rejected') as PromiseRejectedResult;
        const error=new Error(`Native preparation failed: ${String(rejected.reason)}`);
        this.fail(error); throw error;
      }
      const [c,g]=prepared.map(p=>(p as PromiseFulfilledResult<PrepareReply>).value);
      if(c.bytes!==estimates[0].bytes||g.bytes!==estimates[1].bytes||typeof c.inputHash!=='string'||!/^[0-9a-f]{64}$/.test(c.inputHash)||
        c.inputHash!==g.inputHash||c.feature!==g.feature) {
        await Promise.allSettled([this.cpu.request('release',{handle:id}),this.gpu.request('release',{handle:id})]);
        const error=new Error('CPU/GPU input replicas or reservations differ'); this.fail(error); throw error;
      }
      const profileKey=JSON.stringify({algorithm:canonical.algorithm,count:canonical.count,
        mask:canonical.algorithm==='compact-u32' ? canonical.mask : undefined,feature:c.feature,placement});
      const handle:WorkloadHandle=Object.freeze({id,spec:canonical,profileKey,inputHash:c.inputHash,inputPlacement:placement,
        reservedBytes:bytes,prepareUs:(performance.now()-start)*1000});
      this.handles.set(id,{handle,identity,modes:['cpu-serial','cpu-parallel',placement==='resident'?'gpu-resident':'gpu-upload'],
        pending:0,retiring:false,waiters:new Set()});
      this.reserved+=bytes;
      return handle;
    });
    this.lifecycle.add(task); try { return await task; } finally { this.lifecycle.delete(task); }
  }
  profile(handle:WorkloadHandle) {
    const state=this.state(handle);
    const d=this.policy.select(handle.profileKey,state.modes,{cpu:0,gpu:0});
    return {trained:this.policy.trained(handle.profileKey,state.modes),preferred:d.preferred,
      estimates:Object.fromEntries(state.modes.map(m=>[m,this.policy.estimate(handle.profileKey,m)])),
      observations:this.policy.snapshot()[handle.profileKey]};
  }
  status() { return {pending:this.jobs.size,queued:this.queue.length,cpu:!!this.active.cpu,gpu:!!this.active.gpu,
    prepared:this.handles.size,reservedBytes:this.reserved,profileError:this.storageError?.message}; }
  diagnostics() { return {cpu:this.cpu.diagnostics(),gpu:this.gpu.diagnostics()}; }
  run(handle:WorkloadHandle,options:{mode?:WorkloadMode;learn?:boolean}={}):Promise<AdaptiveResult> {
    if(this.calibrating) throw new Error('Calibration requires exclusive execution');
    return this.enqueue(handle,options);
  }
  private enqueue(handle:WorkloadHandle,options:{mode?:WorkloadMode;learn?:boolean}):Promise<AdaptiveResult> {
    this.ready(); const state=this.state(handle);
    if(options.mode&&!state.modes.includes(options.mode)) throw new RangeError('Mode is incompatible with input placement');
    if(options.learn!==undefined&&typeof options.learn!=='boolean') throw new TypeError('learn must be boolean');
    if(this.jobs.size>=this.maxPending) throw new RangeError('Scheduler queue capacity exceeded');
    return new Promise((resolve,reject)=> {
      const job:Job={state,mode:options.mode,learn:options.learn??true,created:performance.now(),contended:false,resolve,reject};
      state.pending++; this.jobs.add(job); this.queue.push(job); this.pump();
    });
  }
  async runBatch(handles:readonly WorkloadHandle[]):Promise<AdaptiveResult[]> {
    const results:Promise<AdaptiveResult|undefined>[]=[],errors:unknown[]=[];
    for(const handle of handles) {
      while(this.jobs.size>=this.maxPending) await new Promise<void>(resolve=>this.capacityWaiters.add(resolve));
      this.ready(); results.push(this.run(handle).catch(e=> { errors.push(e); return undefined; }));
    }
    const completed=await Promise.all(results);
    if(errors.length) throw errors[0];
    return completed as AdaptiveResult[];
  }
  async calibrate(handle:WorkloadHandle,samples=this.policy.config.minSamples):Promise<AdaptiveResult[]> {
    this.ready(); const state=this.state(handle);
    if(this.jobs.size||this.maintenance||this.calibrating) throw new Error('Calibration requires an idle scheduler');
    if(!Number.isInteger(samples)||samples<this.policy.config.minSamples||samples>32) throw new RangeError('Invalid calibration samples');
    this.calibrating=true;
    try {
      for(const mode of state.modes) await this.enqueue(handle,{mode,learn:false});
      const results:AdaptiveResult[]=[];
      for(let i=0;i<samples;i++) for(let j=0;j<state.modes.length;j++)
        results.push(await this.enqueue(handle,{mode:state.modes[(i+j)%state.modes.length]}));
      return results;
    } finally { this.calibrating=false; }
  }
  private queueCosts():Record<Lane,number> {
    const now=performance.now();
    const remaining=(active:Active|undefined)=> {
      if(!active) return 0;
      const elapsed=(now-active.started)*1000,expected=active.decision.estimatedServiceUs;
      return Math.max(expected*.1,expected-elapsed,elapsed-expected);
    };
    return {cpu:remaining(this.active.cpu),gpu:remaining(this.active.gpu)};
  }
  private pump() {
    if(this.timer) { clearTimeout(this.timer); this.timer=undefined; }
    if(this.closed||this.fatal||this.maintenance) return;
    const costs=this.queueCosts();
    for(let i=0;i<this.queue.length;) {
      const job=this.queue[i],key=job.state.handle.profileKey;
      const decision:AdaptiveDecision=job.mode ? {mode:job.mode,preferred:job.mode,reason:'forced',
        estimatedServiceUs:this.policy.estimate(key,job.mode),estimatedFinishUs:costs[lane(job.mode)]+this.policy.estimate(key,job.mode)}
        : this.policy.select(key,job.state.modes,costs,!!this.active.cpu||!!this.active.gpu);
      const target=lane(decision.mode);
      if(this.active[target]) { costs[target]+=decision.estimatedServiceUs; i++; continue; }
      this.queue.splice(i,1); this.start(job,decision);
      costs[target]+=decision.estimatedServiceUs;
    }
    if(this.queue.length) this.timer=setTimeout(()=>this.pump(),2);
  }
  private start(job:Job,decision:AdaptiveDecision) {
    const target=lane(decision.mode),other=this.active[target==='cpu'?'gpu':'cpu'],started=performance.now();
    if(other) { other.job.contended=true; job.contended=true; }
    this.active[target]={job,decision,started};
    if(job.learn) this.policy.started(job.state.handle.profileKey,decision.mode);
    const worker=target==='cpu' ? this.cpu : this.gpu;
    worker.request<RunReply>('run',{handle:job.state.handle.id,mode:decision.mode,poisonBuffers:this.poison}).then(reply=> {
      const end=performance.now(),serviceUs=(end-started)*1000,r=reply.record;
      if(!r.verified||r.inputHash!==job.state.handle.inputHash||r.mode!==decision.mode) throw new Error('Unverified worker result');
      if(job.learn) {
        this.policy.observe(job.state.handle.profileKey,decision.mode,serviceUs,job.contended);
        this.scheduleSave();
      }
      const result:AdaptiveResult={mode:decision.mode,decision,verified:true,checksum:r.checksum,resultCount:r.resultCount,
        digestHex:r.digestHex,serviceUs,queueUs:(started-job.created)*1000,totalUs:(end-job.created)*1000,
        nativeServiceUs:reply.nativeServiceUs,contended:job.contended,workerPid:reply.pid,timings:r.samples[0]};
      this.finish(job,target); job.resolve(result);
    }).catch(error=> {
      if(job.learn) this.policy.failed(job.state.handle.profileKey,decision.mode);
      const e=error instanceof Error ? error : new Error(String(error)); this.fatal=e;
      this.finish(job,target); job.reject(e);
      this.fail(e);
    });
  }
  private fail(error:Error) {
    this.fatal=error;
    for(const queued of this.queue.splice(0)) { this.finish(queued); queued.reject(error); }
  }
  private finish(job:Job,target?:Lane) {
    if(target) delete this.active[target];
    this.jobs.delete(job); job.state.pending--;
    if(!job.state.pending) for(const resolve of job.state.waiters) resolve();
    if(!this.active.cpu&&!this.active.gpu) { for(const resolve of this.activeWaiters) resolve(); this.activeWaiters.clear(); }
    if(!this.jobs.size) { for(const resolve of this.idleWaiters) resolve(); this.idleWaiters.clear(); }
    for(const resolve of this.capacityWaiters) resolve(); this.capacityWaiters.clear();
    this.pump();
  }
  private waitActive():Promise<void> { return this.active.cpu||this.active.gpu ? new Promise(resolve=>this.activeWaiters.add(resolve)) : Promise.resolve(); }
  private waitIdle():Promise<void> { return this.jobs.size ? new Promise(resolve=>this.idleWaiters.add(resolve)) : Promise.resolve(); }
  async release(handle:WorkloadHandle):Promise<void> {
    this.ready(); const state=this.state(handle); state.retiring=true;
    const task=(async()=> {
      if(state.pending) await new Promise<void>(resolve=>state.waiters.add(resolve));
      await this.maintenanceTask(async()=> {
        await Promise.all([this.cpu.request('release',{handle:handle.id}),this.gpu.request('release',{handle:handle.id})]);
        this.handles.delete(handle.id); this.reserved-=handle.reservedBytes;
      });
    })();
    this.lifecycle.add(task); try { await task; } finally { this.lifecycle.delete(task); }
  }
  private scheduleSave() {
    if(!this.saveTimer) this.saveTimer=setTimeout(()=> {
      this.saveTimer=undefined; void this.flush().catch(e=> { this.storageError=e; });
    },100);
  }
  flush():Promise<void> {
    if(this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer=undefined; }
    const snapshot=this.policy.snapshot();
    this.writes=this.writes.catch(()=>{}).then(()=>saveProfile(this.info.profilePath,this.info.fingerprint,snapshot)).then(()=> { this.storageError=undefined; });
    return this.writes;
  }
  close():Promise<void> {
    if(this.closePromise) return this.closePromise;
    this.closing=true;
    return this.closePromise=(async()=> {
      await Promise.allSettled([...this.lifecycle]);
      await this.waitIdle();
      await Promise.all([this.cpu.close(),this.gpu.close()]);
      this.closed=true; this.handles.clear(); this.reserved=0;
      if(this.timer) clearTimeout(this.timer);
      await this.flush();
    })();
  }
}
