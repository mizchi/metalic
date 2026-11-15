import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { GpuResult, GpuModuleResult } from './contract.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
function run(sources: readonly string[], chunkSize:number, repeat:number, language:'expression'|'module'): GpuResult[] | GpuModuleResult[] {
  if (!Array.isArray(sources) || sources.length>4096 || sources.some(s=>typeof s!=='string'))
    throw new TypeError('Expected at most 4096 source strings');
  if (sources.some(s=>Buffer.byteLength(s)>1048576)) throw new RangeError('Source exceeds 1 MiB of UTF-8 bytes');
  if (!Number.isInteger(chunkSize) || chunkSize<1 || chunkSize>1024) throw new RangeError('chunkSize must be 1..1024');
  if (!Number.isInteger(repeat) || repeat<1 || repeat>1000) throw new RangeError('repeat must be 1..1000');
  const result=execFileSync(`${root}build/frontend-metal`,[`${root}native`],{
    input:JSON.stringify({sources,chunkSize,repeat,language}), encoding:'utf8', maxBuffer:256*1024*1024,
    stdio:['pipe','pipe','pipe'],
  });
  return JSON.parse(result);
}
export function parseGpuBatch(sources: readonly string[], chunkSize=64, repeat=1): GpuResult[] {
  return run(sources,chunkSize,repeat,'expression');
}
export function parseGpuModules(sources: readonly string[], chunkSize=64, repeat=1): GpuModuleResult[] {
  return run(sources,chunkSize,repeat,'module') as GpuModuleResult[];
}
