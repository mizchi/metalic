import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModuleReference } from '../src/module-reference.ts';
import { parseGpuModules } from '../src/gpu.ts';
import { TypeKind as K, NodeKind as N, ErrorCode as E, modulePasses } from '../src/contract.ts';

const valid=[
  'fn answer(): u32 { 42 }',
  'fn add(x: u32, y: u32): u32 { x+y }',
  'fn text(x: str): str { x }',
  'fn a(x:u32):u32{ -x*2; } fn b(x:str):str { x }',
  '/* fn hidden */ fn f(x:u32):str { "日本語" }',
  'fn same(x:u32):u32{((x+1)*3)} fn next(x:u32):u32{x-2}',
];

test('module oracle defines binder IDs, function roots and primitive types',()=> {
  const source=valid[1], result=parseModuleReference(source);
  assert.equal(result.diagnostic,null);
  assert.equal(result.functions.length,1);
  const fn=result.functions[0];
  assert.equal(fn.parameters.length,2);
  assert.equal(fn.returnType,K.TypeU32);
  assert.equal(result.nodes[fn.body].kind,N.NAdd);
  const x=result.nodes[result.nodes[fn.body].left!];
  assert.equal(x.binding,fn.parameters[0].binding);
  assert.equal(x.type,K.TypeU32);
});

test('GPU parses, resolves and type-checks function modules without intermediate host waits',()=> {
  const results=parseGpuModules(valid,7);
  assert.equal(results.length,valid.length);
  results.forEach((actual,i)=> {
    const expected=parseModuleReference(valid[i]);
    assert.equal(expected.diagnostic,null);
    assert.deepEqual(actual.diagnostic,null);
    assert.deepEqual(actual.tokens,expected.tokens);
    assert.deepEqual(actual.nodes,expected.nodes);
    assert.deepEqual(actual.functions,expected.functions);
    assert.equal(actual.root,null);
    assert.deepEqual(actual.passes,modulePasses);
    assert.equal(actual.hostWaits,1);
    assert.equal(actual.backend,'metal');
  });
});

test('module errors preserve stage priority and UTF-8 byte offsets',()=> {
  const cases:[string,number][]=[
    ['',E.EFunctionSyntax],['fn f(x:u32):u32 {x',E.EFunctionSyntax],
    ['fn f(x:u32):u32 {}',E.EExpectedOperand],
    ['fn f(x:u32):u32 {(x}',E.EUnclosedParen],
    ['fn f(x:u32):u32 {x;1}',E.EFunctionSyntax],
    ['fn f(x:wat):u32 {x}',E.EUnknownType],
    ['fn f():u32{1} fn f():u32{2}',E.EDuplicateFunction],
    ['fn f(x:u32,x:str):u32{x}',E.EDuplicateParameter],
    ['fn f():u32{missing}',E.EUndefinedName],
    ['fn f(x:str):u32{x+1}',E.ETypeMismatch],
    ['fn f(x:str):u32{x}',E.EReturnType],
    ['fn f():u32{"日本語"+1}',E.ETypeMismatch],
    ['fn f():u32{1} junk',E.EFunctionSyntax],
  ];
  const results=parseGpuModules(cases.map(([s])=>s));
  assert.equal(results.length,cases.length);
  results.forEach((actual,i)=> {
    const [source,code]=cases[i], expected=parseModuleReference(source);
    assert.equal(expected.diagnostic?.code,code,source);
    assert.deepEqual(actual.diagnostic,expected.diagnostic,source);
    assert.deepEqual(actual.nodes,[]);
    assert.deepEqual(actual.functions,[]);
    assert.equal(actual.root,null);
  });
});

test('independent function scopes and chunk alignments agree',()=> {
  const source=Array.from({length:100},(_,i)=>`fn f${i}(x:u32,y:u32):u32{(x-${i})*(y+1)}`).join('\n');
  const sources=Array.from({length:16},(_,i)=>' '.repeat(i)+source);
  const results=parseGpuModules(sources,16);
  assert.equal(results.length,sources.length);
  results.forEach((actual,i)=> {
    const expected=parseModuleReference(sources[i]);
    assert.equal(actual.diagnostic,null);
    assert.deepEqual(actual.nodes,expected.nodes);
    assert.deepEqual(actual.functions,expected.functions);
  });
});

test('damaged declarations have deterministic diagnostics before semantic passes',()=> {
  const base='fn add(x:u32,y:u32):u32{(x+1)*y} fn text(x:str):str{x}';
  const sources:string[]=[];
  for(const token of parseModuleReference(base).tokens) {
    sources.push(base.slice(0,token.begin)+base.slice(token.end));
    for(const inserted of ['@',';',')','{','fn '])
      sources.push(base.slice(0,token.begin)+inserted+base.slice(token.begin));
  }
  const results=parseGpuModules(sources,7);
  results.forEach((actual,i)=> {
    const expected=parseModuleReference(sources[i]);
    assert.deepEqual(actual.diagnostic,expected.diagnostic,sources[i]);
    assert.deepEqual(actual.nodes,expected.nodes,sources[i]);
    assert.deepEqual(actual.functions,expected.functions,sources[i]);
  });
});

test('function and parameter capacities are checked on the GPU',()=> {
  const functions=(count:number)=>Array.from({length:count},(_,i)=>`fn f${i}():u32{${i}}`).join(' ');
  const parameters=(count:number)=>`fn f(${Array.from({length:count},(_,i)=>`p${i}:u32`).join(',')}):u32{p0}`;
  const sources=[functions(256),functions(257),parameters(64),parameters(65)];
  const results=parseGpuModules(sources);
  results.forEach((actual,i)=> {
    const expected=parseModuleReference(sources[i]);
    assert.deepEqual(actual.diagnostic,expected.diagnostic);
    assert.deepEqual(actual.nodes,expected.nodes);
    assert.deepEqual(actual.functions,expected.functions);
  });
  assert.equal(results[0].functions.length,256);
  assert.equal(results[2].functions[0].parameters.length,64);
  assert.equal(results[1].diagnostic?.code,E.ECapacity);
  assert.equal(results[3].diagnostic?.code,E.ECapacity);
});

test('mixed expression forests remain scoped across scan and tree boundaries',()=> {
  let seed=0x3f2c7651;
  const random=()=> { seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed; };
  const expr=(depth:number):string=> {
    if(!depth) return ['x','y','17'][random()%3];
    switch(random()%4) {
      case 0: return `(${expr(depth-1)})`;
      case 1: return `-+${expr(depth-1)}`;
      default: return `${expr(depth-1)}${['+','-','*','/'][random()%4]}${expr(depth-1)}`;
    }
  };
  const source=Array.from({length:128},(_,i)=>`fn f${i}(x:u32,y:u32):u32{${expr(i%7)}}`).join('\n');
  const expected=parseModuleReference(source);
  assert.equal(expected.diagnostic,null);
  for(const chunk of [1,7,64,257]) {
    const [actual]=parseGpuModules([source],chunk);
    assert.equal(actual.diagnostic,null);
    assert.deepEqual(actual.tokens,expected.tokens);
    assert.deepEqual(actual.nodes,expected.nodes);
    assert.deepEqual(actual.functions,expected.functions);
  }
});
