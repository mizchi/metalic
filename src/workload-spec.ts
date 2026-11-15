import { WorkloadLimit as L } from './schema.ts';
import type { WorkloadSpec } from './contract.ts';
const limits:Record<string,number>={'merkle-sha256':L.MaxMerkleLeaves,histogram256:L.MaxHistogramBytes,'compact-u32':L.MaxCompactValues,
  tea32:L.MaxTeaBlocks,'pointer-chase':L.MaxChaseNodes};
export function workloadSpec(spec:WorkloadSpec):Readonly<WorkloadSpec> {
  if(!spec||!Object.hasOwn(limits,spec.algorithm)) throw new TypeError('Unknown workload algorithm');
  if(!Number.isInteger(spec.count)||spec.count<0||spec.count>limits[spec.algorithm]) throw new RangeError('Invalid workload count');
  const seed=spec.seed??0x12345678,mask=spec.mask??1,distribution=spec.distribution??'uniform';
  for(const n of [seed,mask]) if(!Number.isInteger(n)||n<0||n>0xffffffff) throw new RangeError('seed and mask must be u32');
  if(!['uniform','hot'].includes(distribution)||(distribution==='hot'&&spec.algorithm!=='histogram256')) throw new TypeError('Invalid distribution');
  return Object.freeze({algorithm:spec.algorithm,count:spec.count,seed,mask,distribution});
}
