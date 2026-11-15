import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WorkloadLimit as L } from './schema.ts';
import { workloadSpec } from './workload-spec.ts';
import type { WorkloadSpec, WorkloadOptions, WorkloadExperiment, WorkloadMode } from './contract.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
export function runWorkloads(jobs:readonly WorkloadSpec[],options:WorkloadOptions={}):WorkloadExperiment {
  if(!Array.isArray(jobs) || jobs.length>L.MaxWorkloadJobs) throw new TypeError('Expected at most 64 workload jobs');
  for(const job of jobs) {
    workloadSpec(job);
    if(options.includeOutput && job.algorithm==='compact-u32' && job.count>L.MaxWorkloadOutput)
      throw new RangeError('Full output exceeds 8192 elements');
    if(options.includeOutput && job.algorithm==='tea32' && job.count>L.MaxWorkloadOutput/2)
      throw new RangeError('Full output exceeds 8192 elements');
  }
  const warmups=options.warmups??3,samples=options.samples??15;
  if(!Number.isInteger(warmups) || warmups<0 || warmups>10 || !Number.isInteger(samples) || samples<1 || samples>100)
    throw new RangeError('Invalid warmup/sample count');
  const modes=options.modes??['cpu-serial','cpu-parallel','gpu-resident','gpu-upload'] as WorkloadMode[];
  if(!Array.isArray(modes) || !modes.length || new Set(modes).size!==modes.length ||
    modes.some(m=>!['cpu-serial','cpu-parallel','gpu-resident','gpu-upload'].includes(m))) throw new TypeError('Invalid modes');
  for(const value of [options.poisonBuffers,options.includeOutput])
    if(value!==undefined && typeof value!=='boolean') throw new TypeError('Expected boolean debug/output options');
  return JSON.parse(execFileSync(`${root}build/workloads-metal`,[`${root}native`],{
    input:JSON.stringify({jobs,warmups,samples,modes,poisonBuffers:options.poisonBuffers,includeOutput:options.includeOutput}),
    encoding:'utf8',maxBuffer:256*1024*1024,
  }));
}
