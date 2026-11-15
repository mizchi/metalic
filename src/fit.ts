import type { FitSample,FitOptions,FitAssessment,WorkloadMode } from './contract.ts';
const modes:WorkloadMode[]=['cpu-serial','cpu-parallel','gpu-resident','gpu-upload'];
export const quantile=(xs:readonly number[],p:number)=>[...xs].sort((a,b)=>a-b)[Math.ceil((xs.length-1)*p)];

/** Held-out evaluation only. These controls never enter the scheduler profile. */
export function assessFit(reference:readonly FitSample[],automatic:readonly FitSample[],options:Partial<FitOptions>={}):FitAssessment {
  const {relativeTolerance,absoluteToleranceUs,minControlSamples}={relativeTolerance:.1,absoluteToleranceUs:10,minControlSamples:5,...options};
  if(!Number.isFinite(relativeTolerance)||relativeTolerance<0||relativeTolerance>1||
    !Number.isFinite(absoluteToleranceUs)||absoluteToleranceUs<0||!Number.isInteger(minControlSamples)||minControlSamples<3)
    throw new RangeError('Invalid fit tolerances');
  if(!automatic.length) throw new RangeError('Automatic samples must not be empty');
  for(const row of [...reference,...automatic]) if(!modes.includes(row.mode)||!Number.isFinite(row.serviceUs)||row.serviceUs<=0||
      !Number.isFinite(row.apiUs)||row.apiUs<=0) throw new RangeError('Samples must have a known mode and positive finite durations');
  const controls:FitAssessment['controls']={};
  for(const mode of modes) {
    const rows=reference.filter(r=>r.mode===mode);if(!rows.length) continue;
    if(rows.length<minControlSamples) throw new RangeError('Insufficient control samples');
    const xs=rows.map(r=>r.serviceUs);
    controls[mode]={count:rows.length,p25Us:quantile(xs,.25),p50Us:quantile(xs,.5),p75Us:quantile(xs,.75),apiP50Us:quantile(rows.map(r=>r.apiUs),.5)};
  }
  const present=modes.filter(m=>controls[m]),sorted=[...present].sort((a,b)=>controls[a]!.p50Us-controls[b]!.p50Us);
  const cpu=sorted.find(m=>m.startsWith('cpu')),gpu=sorted.find(m=>m.startsWith('gpu'));
  if(!cpu||!gpu) throw new RangeError('Both CPU and GPU control samples are required');
  if(automatic.some(r=>!controls[r.mode])) throw new RangeError('Automatic mode has no matching control');
  const best=sorted[0],cost=(m:WorkloadMode)=>controls[m]!.p50Us;
  const competitive=present.filter(m=>cost(m)<=cost(best)*(1+relativeTolerance)+absoluteToleranceUs);
  const c=controls[cpu]!,g=controls[gpu]!;
  const family=g.p50Us*(1+relativeTolerance)+absoluteToleranceUs<c.p50Us&&g.p75Us<c.p25Us ? 'gpu' :
    c.p50Us*(1+relativeTolerance)+absoluteToleranceUs<g.p50Us&&c.p75Us<g.p25Us ? 'cpu' : 'ambiguous';
  const steady=automatic.filter(r=>r.reason!=='calibrating'&&r.reason!=='explore'&&r.reason!=='queue');
  const fit=(rows:readonly FitSample[])=>rows.length ? rows.filter(r=>competitive.includes(r.mode)).length/rows.length : 0;
  const autoApiP50Us=quantile(automatic.map(r=>r.apiUs),.5);
  return {family,referenceMode:best,competitive,controls,count:automatic.length,steadyCount:steady.length,
    fitRate:fit(automatic),steadyFitRate:fit(steady),
    estimatedRegret:automatic.reduce((sum,r)=>sum+Math.max(0,cost(r.mode)-cost(best)),0)/(automatic.length*cost(best)),
    apiSlowdown:autoApiP50Us/Math.min(...present.map(m=>controls[m]!.apiP50Us)),autoApiP50Us};
}
