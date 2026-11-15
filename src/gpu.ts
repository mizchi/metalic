import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { GpuResult, GpuModuleResult, GpuSummary, GpuOptions } from './contract.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
function request(sources: readonly string[], chunkSize:number, repeat:number, language:'expression'|'module', options:GpuOptions,
    output:'full'|'summary'): string {
  const diagnostics=options.diagnostics ?? 'packed';
  const buffers=options.buffers ?? 'selective';
  const poisonBuffers=options.poisonBuffers ?? false;
  const maxInFlight=options.maxInFlight ?? 1;
  if(!['tree','hierarchical','packed'].includes(diagnostics)) throw new TypeError('Unknown diagnostic strategy');
  if(!['fresh','reuse','selective'].includes(buffers)) throw new TypeError('Unknown buffer strategy');
  if(typeof poisonBuffers!=='boolean') throw new TypeError('poisonBuffers must be a boolean');
  if(!Number.isInteger(maxInFlight) || maxInFlight<1 || maxInFlight>8) throw new RangeError('maxInFlight must be 1..8');
  if (!Array.isArray(sources) || sources.length>4096 || sources.some(s=>typeof s!=='string'))
    throw new TypeError('Expected at most 4096 source strings');
  if (sources.some(s=>Buffer.byteLength(s)>1048576)) throw new RangeError('Source exceeds 1 MiB of UTF-8 bytes');
  if (!Number.isInteger(chunkSize) || chunkSize<1 || chunkSize>1024) throw new RangeError('chunkSize must be 1..1024');
  if (!Number.isInteger(repeat) || repeat<1 || repeat>1000) throw new RangeError('repeat must be 1..1000');
  return JSON.stringify({sources,chunkSize,repeat,language,diagnostics,buffers,poisonBuffers,maxInFlight,output});
}
function run(sources: readonly string[], chunkSize:number, repeat:number, language:'expression'|'module', options:GpuOptions,
    output:'full'|'summary'): GpuResult[] | GpuSummary[] {
  const input=request(sources,chunkSize,repeat,language,options,output);
  const result=execFileSync(`${root}build/frontend-metal`,[`${root}native`],{
    input, encoding:'utf8', maxBuffer:256*1024*1024,
    stdio:['pipe','pipe','pipe'],
  });
  return JSON.parse(result);
}
export function parseGpuBatch(sources: readonly string[], chunkSize=64, repeat=1, options:GpuOptions={}): GpuResult[] {
  return run(sources,chunkSize,repeat,'expression',options,'full') as GpuResult[];
}
export function parseGpuModules(sources: readonly string[], chunkSize=64, repeat=1, options:GpuOptions={}): GpuModuleResult[] {
  return run(sources,chunkSize,repeat,'module',options,'full') as GpuModuleResult[];
}
export function checkGpuBatch(sources: readonly string[], chunkSize=64, repeat=1, options:GpuOptions={}): GpuSummary[] {
  return run(sources,chunkSize,repeat,'expression',options,'summary') as GpuSummary[];
}
export function checkGpuModules(sources: readonly string[], chunkSize=64, repeat=1, options:GpuOptions={}): GpuSummary[] {
  return run(sources,chunkSize,repeat,'module',options,'summary') as GpuSummary[];
}
async function checkAsync(sources: readonly string[], chunkSize:number, repeat:number, language:'expression'|'module', options:GpuOptions): Promise<GpuSummary[]> {
  // Serialize an immutable request snapshot before returning control to the caller.
  const input=request(sources,chunkSize,repeat,language,options,'summary');
  return new Promise((resolve,reject)=> {
    const child=execFile(`${root}build/frontend-metal`,[`${root}native`],
      {encoding:'utf8',maxBuffer:256*1024*1024},(error,stdout)=> {
        if(error) { reject(error); return; }
        try { resolve(JSON.parse(stdout)); } catch(error) { reject(error); }
      });
    // Early process exit may close stdin before the whole snapshot was written.
    child.stdin!.on('error',reject);
    child.stdin!.end(input);
  });
}
/** The Node event loop stays available; each call still owns a native process. */
export function checkGpuBatchAsync(sources: readonly string[], chunkSize=64, repeat=1, options:GpuOptions={}): Promise<GpuSummary[]> {
  return checkAsync(sources,chunkSize,repeat,'expression',options);
}
export function checkGpuModulesAsync(sources: readonly string[], chunkSize=64, repeat=1, options:GpuOptions={}): Promise<GpuSummary[]> {
  return checkAsync(sources,chunkSize,repeat,'module',options);
}
