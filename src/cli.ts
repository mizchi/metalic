import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseGpuBatch, parseGpuModules } from './gpu.ts';
import { parseReference } from './reference.ts';
import { parseModuleReference } from './module-reference.ts';
import { TokenKind, NodeKind, ErrorCode } from './contract.ts';
import type { DiagnosticStrategy } from './contract.ts';
const name=(table:Record<string,number>,value:number)=>Object.entries(table).find(([,v])=>v===value)?.[0];
try {
  const {values,positionals}=parseArgs({options:{cpu:{type:'boolean'},module:{type:'boolean'},summary:{type:'boolean'},
    'chunk-size':{type:'string'},diagnostics:{type:'string'}},allowPositionals:true});
  if(positionals.length!==1) throw new Error('usage: pnpm parse [--module] [--cpu] [--summary] [--chunk-size N] [--diagnostics tree|hierarchical|packed] <file>');
  const source=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(positionals[0]));
  const bytes=Buffer.from(source);
  const cpu=values.module ? parseModuleReference : parseReference;
  const gpu=values.module ? parseGpuModules : parseGpuBatch;
  const result=values.cpu ? cpu(source) : gpu([source],Number(values['chunk-size']??64),1,
    {diagnostics:values.diagnostics as DiagnosticStrategy | undefined})[0];
  const diagnostic=result.diagnostic && {...result.diagnostic,name:name(ErrorCode,result.diagnostic.code)};
  const output=values.summary ? {...result,tokens:result.tokens.length,nodes:result.nodes.length,diagnostic}
    : {...result,diagnostic,
      tokens:result.tokens.map(t=>({...t,name:name(TokenKind,t.kind),text:bytes.subarray(t.begin,t.end).toString()})),
      nodes:result.nodes.map(n=>({...n,name:name(NodeKind,n.kind)}))};
  console.log(JSON.stringify(output,null,2));
  if(diagnostic) process.exitCode=1;
} catch(error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode=1;
}
