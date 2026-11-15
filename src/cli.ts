import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseGpuBatch, parseGpuModules, checkGpuBatch, checkGpuModules } from './gpu.ts';
import { parseReference } from './reference.ts';
import { parseModuleReference } from './module-reference.ts';
import { TokenKind, NodeKind, ErrorCode } from './contract.ts';
import type { DiagnosticStrategy, BufferStrategy } from './contract.ts';
const name=(table:Record<string,number>,value:number)=>Object.entries(table).find(([,v])=>v===value)?.[0];
try {
  const {values,positionals}=parseArgs({options:{cpu:{type:'boolean'},module:{type:'boolean'},summary:{type:'boolean'},
    'chunk-size':{type:'string'},diagnostics:{type:'string'},buffers:{type:'string'},'in-flight':{type:'string'}},allowPositionals:true});
  if(!positionals.length) throw new Error('usage: pnpm parse [--module] [--cpu] [--summary] [--chunk-size N] [--diagnostics tree|hierarchical|packed] [--buffers fresh|reuse|selective] [--in-flight 1..8] <files...>');
  const sources=positionals.map(path=>new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(path)));
  const cpu=values.module ? parseModuleReference : parseReference;
  const gpu=values.summary ? (values.module ? checkGpuModules : checkGpuBatch) : (values.module ? parseGpuModules : parseGpuBatch);
  const results=values.cpu ? sources.map(cpu) : gpu(sources,Number(values['chunk-size']??64),1,
    {diagnostics:values.diagnostics as DiagnosticStrategy | undefined,buffers:values.buffers as BufferStrategy | undefined,
      maxInFlight:Number(values['in-flight']??1)});
  const outputs=results.map((result,i)=> {
    const bytes=Buffer.from(sources[i]);
    const diagnostic=result.diagnostic && {...result.diagnostic,name:name(ErrorCode,result.diagnostic.code)};
    if(diagnostic) process.exitCode=1;
    if(!('tokens' in result)) return {...result,diagnostic};
    return values.summary ? {...result,tokens:result.tokens.length,nodes:result.nodes.length,diagnostic}
    : {...result,diagnostic,
      tokens:result.tokens.map(t=>({...t,name:name(TokenKind,t.kind),text:bytes.subarray(t.begin,t.end).toString()})),
      nodes:result.nodes.map(n=>({...n,name:name(NodeKind,n.kind)}))};
  });
  console.log(JSON.stringify(outputs.length===1 ? outputs[0] : outputs,null,2));
} catch(error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode=1;
}
