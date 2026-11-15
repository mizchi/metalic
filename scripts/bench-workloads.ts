import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runWorkloads } from '../src/workloads.ts';
import type { WorkloadSpec } from '../src/contract.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const jobs:WorkloadSpec[]=[
  ...[1,256,4096,65536,262144].map(count=>({algorithm:'merkle-sha256',count}) as const),
  ...[4096,65536,1048576,16777216,67108864].flatMap(count=>['uniform','hot'].map(distribution=>
    ({algorithm:'histogram256',count,distribution}) as WorkloadSpec)),
  ...[256,4096,65536,1048576,4194304,16777216].map(count=>({algorithm:'compact-u32',count}) as const),
];
const warmups=3,samples=15;
const result=runWorkloads(jobs,{warmups,samples});
const quantile=(xs:number[],p:number)=>[...xs].sort((a,b)=>a-b)[Math.ceil((xs.length-1)*p)];
const records=result.records.map(r=>({...r,p50Us:quantile(r.samples.map(s=>s.elapsedUs),.5),
  p95Us:quantile(r.samples.map(s=>s.elapsedUs),.95),gpuP50Us:quantile(r.samples.map(s=>s.gpuUs),.5),
  consumeP50Us:quantile(r.samples.map(s=>s.consumeUs),.5)}));
const sourcePaths=['native/contract.h','native/buffers.h','native/workloads.mm','native/workloads.metal',
  'native/workloads_cpu.h','native/workloads_plan.h','scripts/build.mjs','scripts/bench-workloads.ts',
  'src/schema.ts','src/contract.ts','src/workloads.ts'];
const output={measuredAt:new Date().toISOString(),node:process.version,
  macOS:execFileSync('sw_vers',['-productVersion'],{encoding:'utf8'}).trim(),
  compiler:execFileSync('xcrun',['clang++','--version'],{encoding:'utf8'}).split('\n')[0],
  buildFlags:['-O3','-std=c++17','-fobjc-arc'],warmups,samples,device:result.device,mslVersion:result.mslVersion,
  cpuThreads:result.cpuThreads,setupUs:result.setupUs,
  sourceHashes:Object.fromEntries(sourcePaths.map(p=>[p,createHash('sha256').update(readFileSync(`${root}${p}`)).digest('hex')])),
  notes:[
    'One native process/library. All modes rotate order each round; preallocated CPU/GPU buffers and three warmups per job.',
    'CPU serial and GCD parallel are clang -O3; Merkle SHA-256 uses CommonCrypto, histogram uses four private stripes per worker.',
    'CPU compaction uses branchless predicate advancement; parallel scatter has a monotone end guard to avoid crossing chunk ownership.',
    'GCD schedules up to four chunks per available core for load balance. cpuTasks is chunk count, not physical cores.',
    'All modes materialize the same full output and CPU consumes it with the same order-sensitive u32 checksum.',
    'GPU resident reuses uploaded input. GPU upload includes memcpy from caller-owned CPU input each run.',
    'elapsedUs includes required upload, encode, completion wait, final count inspection and CPU result consumption.',
    'Setup, allocations, deterministic input generation, reference generation, JSON/IPC are outside warm timings.',
    'Every timed output is fully compared with native CPU after the timer. Post-timer comparisons can warm caches.',
    'Merkle uses 64-byte leaves and SHA256(left32 || right32), duplicating odd nodes; empty tree is SHA256(empty).',
    'Histogram counts bytes into 256 bins; hot distribution is byte 7. Compaction keeps (value & mask)==0, preserving order.',
    'GPU time is the command interval, not full request time. Best CPU comparisons use min(serial p50, parallel p50) per job.',
    'Real Apple GPU, MSL 4.0, original MTLCommandQueue API. One completion wait per workload; no intermediate host counts.',
    'Poisoning/validation disabled for performance runs. Frequency, CPU core placement and OS load are uncontrolled.',
  ],records};
writeFileSync(`${root}build/workloads-benchmark.json`,JSON.stringify(output,null,2)+'\n');
console.table(jobs.map((job,i)=> {
  const rs=records.slice(i*4,i*4+4),cpu=Math.min(rs[0].p50Us,rs[1].p50Us);
  return {algorithm:job.algorithm,count:job.count,distribution:job.distribution??'',
    'CPU serial ms':+(rs[0].p50Us/1000).toFixed(3),'CPU parallel ms':+(rs[1].p50Us/1000).toFixed(3),
    'GPU resident ms':+(rs[2].p50Us/1000).toFixed(3),'GPU upload ms':+(rs[3].p50Us/1000).toFixed(3),
    'resident speedup':+(cpu/rs[2].p50Us).toFixed(2),'upload speedup':+(cpu/rs[3].p50Us).toFixed(2)};
}));
