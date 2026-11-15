import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WorkloadLimit as L } from './schema.ts';
import type { WorkloadSpec, WorkloadOptions, WorkloadExperiment, WorkloadMode } from './contract.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const limits:Record<string,number>={'merkle-sha256':L.MaxMerkleLeaves,histogram256:L.MaxHistogramBytes,'compact-u32':L.MaxCompactValues};
export function runWorkloads(jobs:readonly WorkloadSpec[],options:WorkloadOptions={}):WorkloadExperiment {
  if(!Array.isArray(jobs) || jobs.length>L.MaxWorkloadJobs) throw new TypeError('Expected at most 64 workload jobs');
  for(const job of jobs) {
    if(!job || !Object.hasOwn(limits,job.algorithm)) throw new TypeError('Unknown workload algorithm');
    if(!Number.isInteger(job.count) || job.count<0 || job.count>limits[job.algorithm]) throw new RangeError('Invalid workload count');
    for(const n of [job.seed??0x12345678,job.mask??1])
      if(!Number.isInteger(n) || n<0 || n>0xffffffff) throw new RangeError('seed and mask must be u32');
    if(job.distribution!==undefined && !['uniform','hot'].includes(job.distribution)) throw new TypeError('Unknown distribution');
    if(job.distribution==='hot' && job.algorithm!=='histogram256') throw new TypeError('hot distribution requires histogram256');
    if(options.includeOutput && job.algorithm==='compact-u32' && job.count>L.MaxWorkloadOutput)
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
