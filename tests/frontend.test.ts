import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReference } from '../src/reference.ts';
import { parseGpuBatch } from '../src/gpu.ts';
import { NodeKind as N, ErrorCode as E, passes } from '../src/contract.ts';

test('CPU oracle fixes precedence, left associativity and prefix associativity',()=> {
  const left=parseReference('a-b-c');
  assert.equal(left.nodes[left.root!].kind,N.NSub);
  assert.equal(left.nodes[left.nodes[left.root!].left!].kind,N.NSub);
  const product=parseReference('a+b*c');
  assert.equal(product.nodes[product.nodes[product.root!].right!].kind,N.NMul);
  const unary=parseReference('--a');
  assert.equal(unary.root,0);
  assert.equal(unary.nodes[0].right,1);
});

test('real Metal lexer and parser match the independent CPU oracle',()=> {
  const sources=[
    '1', '4294967295', 'a-b-c', 'a+b*c', '--a', '-a*-b+c/-d',
    '((a+b)*(c-d))', 'a; b+c; d*e;', '  /* hi */ a // tail\n + b',
    '"a\\\"b" + "日本語"', '"/* not comment */"; 1/2',
    `${'('.repeat(512)}a${')'.repeat(512)}`, `name_${'a'.repeat(1024)}+7`,
    Array.from({length:256},(_,i)=>`v${i} * ${i}`).join('+')
  ];
  const results=parseGpuBatch(sources);
  assert.equal(results.length,sources.length);
  results.forEach((actual,i)=> {
    const expected=parseReference(sources[i]);
    assert.deepEqual(actual.diagnostic,expected.diagnostic, sources[i].slice(0,80));
    assert.deepEqual(actual.tokens,expected.tokens);
    assert.deepEqual(actual.nodes,expected.nodes);
    assert.equal(actual.root,expected.root);
    assert.equal(actual.backend,'metal');
    assert.deepEqual(actual.passes,passes);
    assert.equal(actual.hostWaits,1);
    assert.ok(actual.dispatches>0);
  });
});

test('malformed input has deterministic UTF-8 byte diagnostics',()=> {
  const sources=['',' ', '1 2', '1+', '*a', '()', ')', '((a)', '(a;b)',
    'a;;b', '4294967296', '@', '/* missing', '"missing', 'a+"日本語" @'];
  const results=parseGpuBatch(sources);
  assert.equal(results.length,sources.length);
  results.forEach((actual,i)=> {
    assert.deepEqual(actual.diagnostic,parseReference(sources[i]).diagnostic,sources[i]);
    assert.equal(actual.root,null);
    assert.deepEqual(actual.nodes,[]);
  });
  assert.deepEqual(parseReference('4294967296').diagnostic,{code:E.EIntegerOverflow,offset:0});
});

test('lexical state and token spans are independent of chunk alignment',()=> {
  const body='identifier123 + "x\\\"y" /* across */ / 23 // across\n - -name';
  const sources=Array.from({length:64},(_,i)=>' '.repeat(i)+body);
  const results=parseGpuBatch(sources,16);
  assert.equal(results.length,sources.length);
  results.forEach((actual,i)=> {
    const expected=parseReference(sources[i]);
    assert.deepEqual(actual.tokens,expected.tokens,`alignment ${i}`);
    assert.deepEqual(actual.diagnostic,expected.diagnostic);
    assert.deepEqual(actual.nodes,expected.nodes);
    assert.equal(actual.root,expected.root);
  });
});

test('line comments end at CR as well as LF',()=> {
  const source='1 + // comment\r2';
  assert.equal(parseReference(source).diagnostic,null);
  assert.equal(parseReference(source).nodes.length,3);
  const [gpu]=parseGpuBatch([source]);
  assert.deepEqual(gpu.nodes,parseReference(source).nodes);
});

test('seeded differential cases cover mixed nesting and all chunk sizes',()=> {
  let seed=0x42c0ffee;
  const random=()=> { seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed; };
  const expr=(depth:number):string=> {
    if (!depth || random()%4===0) return random()%2 ? `v${random()%100}` : `${random()%10000}`;
    switch(random()%4) {
      case 0:return `(${expr(depth-1)})`;
      case 1:return `- + ${expr(depth-1)}`;
      default:return `${expr(depth-1)} ${['+','-','*','/'][random()%4]} ${expr(depth-1)}`;
    }
  };
  const sources=Array.from({length:192},()=>expr(5));
  sources.push('-'.repeat(2048)+'1', Array.from({length:1024},(_,i)=>String(i)).join('-'));
  for(const chunk of [1,7,64,257]) {
    const results=parseGpuBatch(sources,chunk);
    results.forEach((actual,i)=> {
      const expected=parseReference(sources[i]);
      assert.equal(expected.diagnostic,null);
      assert.deepEqual(actual.diagnostic,null,`${chunk}: ${sources[i].slice(0,80)}`);
      assert.deepEqual(actual.tokens,expected.tokens);
      assert.deepEqual(actual.nodes,expected.nodes);
      assert.equal(actual.root,expected.root);
    });
  }
});

test('invalid mutations report the same first error without publishing an AST',()=> {
  const bases=['a+b*c','---a/(b+c)','(a-(b-c))*d','a;b+c;','"日本語"+name'];
  const sources= bases.flatMap(source=>Array.from({length:source.length+1},(_,i)=>[
    source.slice(0,i)+'@'+source.slice(i),
    source.slice(0,i)+';'+source.slice(i),
    source.slice(0,i)+')'+source.slice(i),
  ]).flat());
  const results=parseGpuBatch(sources,7);
  results.forEach((actual,i)=> {
    const expected=parseReference(sources[i]);
    assert.deepEqual(actual.diagnostic,expected.diagnostic,sources[i]);
    assert.deepEqual(actual.tokens,expected.tokens,sources[i]);
    assert.deepEqual(actual.nodes,expected.nodes,sources[i]);
    assert.equal(actual.root,expected.root,sources[i]);
  });
});

test('request contracts reject invalid sizes before GPU allocation',()=> {
  for(const chunk of [0,-1,1.5,NaN,1025]) assert.throws(()=>parseGpuBatch(['1'],chunk),RangeError);
  for(const repeat of [0,1.5,1001]) assert.throws(()=>parseGpuBatch(['1'],64,repeat),RangeError);
  assert.throws(()=>parseGpuBatch(['x'.repeat(1048577)]),RangeError);
});

test('three-level group scans preserve an 80,001-node left-associative tree',()=> {
  const source='1+'.repeat(40000)+'1';
  const expected=parseReference(source);
  const [actual]=parseGpuBatch([source]);
  assert.equal(actual.diagnostic,null);
  assert.equal(actual.nodes.length,80001);
  assert.deepEqual(actual.tokens,expected.tokens);
  assert.deepEqual(actual.nodes,expected.nodes);
  assert.equal(actual.root,expected.root);
});
