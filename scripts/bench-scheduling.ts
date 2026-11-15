import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseGpuModules, checkGpuModules } from '../src/gpu.ts';
import { parseModuleReference } from '../src/module-reference.ts';
import type { FlightTrace } from '../src/contract.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const warmups=2,samples=10;
const quantile=(xs:number[],p:number)=>[...xs].sort((a,b)=>a-b)[Math.ceil((xs.length-1)*p)];
const sha=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
type Interval=[number,number];
function overlap(traces:FlightTrace[],cpu:(t:FlightTrace)=>Interval):number|null {
  if(traces.some(t=>t.gpuStartedUs===null || t.gpuEndedUs===null)) return null;
  const gpu=traces.map(t=>[t.gpuStartedUs!,t.gpuEndedUs!] as Interval).sort((a,b)=>a[0]-b[0]);
  const merged:Interval[]=[];
  for(const [begin,end] of gpu) {
    const last=merged.at(-1);
    if(last && begin<=last[1]) last[1]=Math.max(last[1],end);
    else merged.push([begin,end]);
  }
  return traces.reduce((sum,t)=> {
    const [a,b]=cpu(t);
    return sum+merged.reduce((n,[c,d])=>n+Math.max(0,Math.min(b,d)-Math.max(a,c)),0);
  },0);
}
const modes=[1,3,8].flatMap(maxInFlight=>['full','summary'].map(output=>({maxInFlight,output})));
const records=[];
for(const [functions,batchSize] of [[1,32],[32,16],[256,8]]) {
  const sources=Array.from({length:batchSize},(_,index)=>Array.from({length:functions},(_,i)=>
    `fn f${i}(x:u32,y:u32):u32{${Array.from({length:8},(_,j)=>`(x+${index+j})*y`).join('+')}}`).join('\n'));
  const expected=sources.map(parseModuleReference);
  const rows=modes.map(mode=>({functions,batchSize,...mode,trials:[] as Record<string,unknown>[]}));
  for(let round=0;round<warmups+samples;round++) {
    for(let order=0;order<modes.length;order++) {
      const index=(round+order)%modes.length,mode=modes[index];
      const start=performance.now();
      const results=mode.output==='full' ? parseGpuModules(sources,64,1,{maxInFlight:mode.maxInFlight})
        : checkGpuModules(sources,64,1,{maxInFlight:mode.maxInFlight});
      const apiWallUs=(performance.now()-start)*1000;
      results.forEach((r,i)=> {
        assert.equal(r.hostWaits,1); assert.equal(r.mslVersion,'4.0');
        assert.deepEqual(r.diagnostic,expected[i].diagnostic);
        if('nodes' in r) {
          assert.deepEqual(r.tokens,expected[i].tokens);
          assert.deepEqual(r.nodes,expected[i].nodes);
          assert.deepEqual(r.functions,expected[i].functions);
        } else {
          assert.equal(r.tokenCount,expected[i].tokens.length);
          assert.equal(r.nodeCount,expected[i].nodes.length);
          assert.equal(r.functionCount,expected[i].functions.length);
        }
      });
      if(round<warmups) continue;
      const traces=results.flatMap(r=>r.flightSamples);
      rows[index].trials.push({round:round-warmups,apiWallUs,batch:results[0].batch,setupUs:results[0].setupUs,
        prepareOverlapUs:overlap(traces,t=>[t.prepareBeginUs,t.submittedUs]),
        consumeOverlapUs:overlap(traces,t=>[t.consumeBeginUs,t.consumeEndUs]),
        cpuPrepareEncodeUs:results.reduce((sum,r)=>sum+r.timingsUs.prepareUs+r.timingsUs.acquireUs+r.timingsUs.initializeUs+r.timingsUs.encodeUs,0),
        cpuMaterializeUs:results.reduce((sum,r)=>sum+r.timingsUs.materializeUs,0),
        completionWaitUs:traces.reduce((sum,t)=>sum+t.completionWaitUs,0),
        gpuSumUs:results.reduce((sum,r)=>sum+r.gpuUs,0),traces});
    }
  }
  for(const row of rows) {
    const trials=row.trials as unknown as {apiWallUs:number;batch:{wallUs:number;peakBufferBytes:number};
      prepareOverlapUs:number|null;consumeOverlapUs:number|null}[];
    records.push({...row,inputBytes:sources.reduce((n,s)=>n+Buffer.byteLength(s),0),inputHashes:sources.map(sha),
      nativeBatchP50Us:quantile(trials.map(t=>t.batch.wallUs),.5),nativeBatchP95Us:quantile(trials.map(t=>t.batch.wallUs),.95),
      apiP50Us:quantile(trials.map(t=>t.apiWallUs),.5),peakBufferBytes:Math.max(...trials.map(t=>t.batch.peakBufferBytes)),
      prepareOverlapP50Us:trials.every(t=>t.prepareOverlapUs!==null) ? quantile(trials.map(t=>t.prepareOverlapUs!),.5) : null,
      consumeOverlapP50Us:trials.every(t=>t.consumeOverlapUs!==null) ? quantile(trials.map(t=>t.consumeOverlapUs!),.5) : null});
  }
}
const paths=['native/contract.h','native/passes.h','native/buffers.h','native/arena.h','native/flight.h','native/batch.h',
  'native/frontend.metal','native/module.metal','native/main.mm','scripts/build.mjs','scripts/bench-scheduling.ts',
  'src/contract.ts','src/gpu.ts','src/module-reference.ts','src/reference.ts'];
const output={measuredAt:new Date().toISOString(),node:process.version,
  macOS:execFileSync('sw_vers',['-productVersion'],{encoding:'utf8'}).trim(),
  compiler:execFileSync('xcrun',['clang++','--version'],{encoding:'utf8'}).split('\n')[0],warmups,samples,
  sourceHashes:Object.fromEntries(paths.map(path=>[path,sha(readFileSync(`${root}${path}`))])),notes:[
    'Independent modules with fixed input hashes and GPU kernels. Every job materializes its selected output; repeat=1.',
    'Compare slot counts WITHIN each output contract. Full AST and compact summary have different outputs.',
    'Modes rotate each round. Each trial starts its own native process/library and empty pools; OS shader cache is not reset.',
    'Native batch wall includes first buffer allocations, all GPU completions and all native result consumption; excludes library setup and JSON/IPC.',
    'API wall includes process/setup, JSON encoding, IPC and JS JSON.parse; CPU oracle validation follows the timed interval.',
    'Overlap is intersection with GPU-reported command execution envelopes on the host clock, not GPU active-cycle profiling.',
    'Flight completion timestamps are CPU completion-handler notifications; GPU start/end timestamps are separate.',
    'peakBufferBytes is retained Metal source/arena resource length, not RSS. Increasing slots retains more buffers.',
    '10 samples are descriptive; OS frequency and external load are uncontrolled. No native CPU performance baseline or speedup claim.',
  ],records};
writeFileSync(`${root}build/scheduling-benchmark.json`,JSON.stringify(output,null,2)+'\n');
console.table(records.map(r=>({functions:r.functions,batch:r.batchSize,slots:r.maxInFlight,output:r.output,
  'native batch ms':+(r.nativeBatchP50Us/1000).toFixed(3),'API ms':+(r.apiP50Us/1000).toFixed(3),
  'prepare overlap µs':r.prepareOverlapP50Us===null ? null : Math.round(r.prepareOverlapP50Us),
  'consume overlap µs':r.consumeOverlapP50Us===null ? null : Math.round(r.consumeOverlapP50Us),
  'buffers MiB':+(r.peakBufferBytes/1048576).toFixed(2)})));
