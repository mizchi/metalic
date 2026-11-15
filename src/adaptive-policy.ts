import type { AdaptivePolicyConfig, AdaptiveProfiles, AdaptiveEntry, AdaptiveDecision, WorkloadMode } from './contract.ts';
export const lane=(mode:WorkloadMode):'cpu'|'gpu'=>mode.startsWith('cpu') ? 'cpu' : 'gpu';
export const policyDefaults:AdaptivePolicyConfig={minSamples:3,window:9,recheckEvery:64,switchMargin:.1};
const median=(xs:number[])=> { const sorted=[...xs].sort((a,b)=>a-b),m=Math.floor(sorted.length/2); return sorted.length%2 ? sorted[m] : (sorted[m-1]+sorted[m])/2; };

/** Pure placement state: no processes, files, clocks or GPU resources. */
export class AdaptivePolicy {
  readonly config:AdaptivePolicyConfig;
  private profiles:AdaptiveProfiles;
  private pending=new Map<string,number>();
  private clock=0;
  constructor(config:Partial<AdaptivePolicyConfig>={},profiles:AdaptiveProfiles={}) {
    this.config={...policyDefaults,...config};
    const c=this.config;
    if(!Number.isInteger(c.minSamples)||c.minSamples<1||c.minSamples>32 || !Number.isInteger(c.window)||c.window<c.minSamples||c.window>64 ||
      !Number.isInteger(c.recheckEvery)||c.recheckEvery<3 || !Number.isFinite(c.switchMargin)||c.switchMargin<0||c.switchMargin>.5)
      throw new RangeError('Invalid adaptive policy configuration');
    this.profiles=Object.assign(Object.create(null),structuredClone(profiles));
    for(const e of Object.values(this.profiles)) for(const s of Object.values(e.modes)) if(s) {
      this.clock=Math.max(this.clock,s.lastUsed);
      s.samples=[...s.samples.filter(x=>!x.contended).slice(-c.window),...s.samples.filter(x=>x.contended).slice(-c.window)];
    }
  }
  private entry(key:string):AdaptiveEntry {
    if(!Object.hasOwn(this.profiles,key) && Object.keys(this.profiles).length>=256) {
      const idle=Object.entries(this.profiles).filter(([k,e])=>Object.keys(e.modes).every(m=>!(this.pending.get(k+'\0'+m)??0)))
        .sort(([,a],[,b])=>Math.max(0,...Object.values(a.modes).map(s=>s!.lastUsed))-Math.max(0,...Object.values(b.modes).map(s=>s!.lastUsed)));
      if(!idle.length) throw new Error('Too many active profile keys');
      delete this.profiles[idle[0][0]];
    }
    return this.profiles[key]??=( {modes:{},incumbent:'cpu-serial',decisions:0} );
  }
  estimate(key:string,mode:WorkloadMode,contended=false):number {
    const samples=this.entry(key).modes[mode]?.samples??[];
    const matching=samples.filter(s=>s.contended===contended);
    const use=matching.length>=this.config.minSamples ? matching : samples;
    return use.length ? median(use.map(s=>s.us)) : 1000;
  }
  trained(key:string,modes:WorkloadMode[]):boolean {
    return modes.every(m=>(this.entry(key).modes[m]?.samples.length??0)>=this.config.minSamples);
  }
  select(key:string,modes:WorkloadMode[],queues:{cpu:number;gpu:number},contended=false):AdaptiveDecision {
    const e=this.entry(key),cost=(m:WorkloadMode)=>this.estimate(key,m,contended);
    const finish=(m:WorkloadMode)=>queues[lane(m)]+cost(m);
    const decision=(mode:WorkloadMode,preferred:WorkloadMode,reason:AdaptiveDecision['reason']):AdaptiveDecision=>
      ({mode,preferred,reason,estimatedServiceUs:cost(mode),estimatedFinishUs:finish(mode)});
    const count=(m:WorkloadMode)=>(e.modes[m]?.samples.length??0)+(this.pending.get(key+'\0'+m)??0);
    const learning=modes.filter(m=>count(m)<this.config.minSamples).sort((a,b)=>count(a)-count(b)||finish(a)-finish(b));
    if(learning.length) return decision(learning[0],e.incumbent,'calibrating');
    const bestCpu=modes.filter(m=>lane(m)==='cpu').sort((a,b)=>cost(a)-cost(b))[0];
    if(bestCpu&&lane(e.incumbent)==='cpu'&&cost(bestCpu)<cost(e.incumbent)*(1-this.config.switchMargin)) e.incumbent=bestCpu;
    const fastest=[...modes].sort((a,b)=>cost(a)-cost(b))[0];
    if(!modes.includes(e.incumbent) || cost(fastest)<cost(e.incumbent)*(1-this.config.switchMargin)) e.incumbent=fastest;
    const preferred=e.incumbent;
    if(e.decisions>0 && e.decisions%this.config.recheckEvery===0) {
      const alternatives=modes.filter(m=>m!==preferred && this.clock-(e.modes[m]?.lastUsed??0)>=
        this.config.recheckEvery*Math.max(1,cost(m)/cost(preferred)))
        .sort((a,b)=>(e.modes[a]?.lastUsed??0)-(e.modes[b]?.lastUsed??0));
      if(alternatives.length) return decision(alternatives[0],preferred,'explore');
    }
    // A queue can justify a different processor, while small differences between
    // serial/parallel on the same CPU lane still respect the noise margin.
    const other=modes.filter(m=>lane(m)!==lane(preferred)).sort((a,b)=>finish(a)-finish(b))[0];
    if(other && finish(other)<finish(preferred) && (queues.cpu>0||queues.gpu>0)) return decision(other,preferred,'queue');
    return decision(preferred,preferred,preferred===fastest ? 'fastest' : 'hysteresis');
  }
  started(key:string,mode:WorkloadMode) {
    this.entry(key).decisions++;
    const id=key+'\0'+mode; this.pending.set(id,(this.pending.get(id)??0)+1);
  }
  failed(key:string,mode:WorkloadMode) {
    const id=key+'\0'+mode,left=Math.max(0,(this.pending.get(id)??0)-1);
    if(left) this.pending.set(id,left); else this.pending.delete(id);
  }
  observe(key:string,mode:WorkloadMode,us:number,contended:boolean) {
    if(!Number.isFinite(us)||us<=0) throw new RangeError('Profile duration must be positive and finite');
    this.failed(key,mode);
    const e=this.entry(key),stats=e.modes[mode]??={samples:[],lastUsed:0};
    stats.lastUsed=++this.clock;
    stats.samples.push({us,contended,at:Date.now()});
    const own=stats.samples.filter(s=>s.contended===contended).slice(-this.config.window);
    const other=stats.samples.filter(s=>s.contended!==contended).slice(-this.config.window);
    stats.samples=[...own,...other].sort((a,b)=>a.at-b.at);
  }
  snapshot():AdaptiveProfiles { return structuredClone(this.profiles); }
}
