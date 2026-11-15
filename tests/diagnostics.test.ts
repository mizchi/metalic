import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGpuBatch, parseGpuModules } from '../src/gpu.ts';
import { parseReference } from '../src/reference.ts';
import { parseModuleReference } from '../src/module-reference.ts';
import { ErrorCode as E } from '../src/contract.ts';

const strategies=['tree','hierarchical','packed'] as const;

test('diagnostic strategies preserve stage priority, ties and UTF-8 spans',()=> {
  const sources=[
    'fn f(x:u32):u32{x+1}',
    'fn f():str{"日本語"}',
    'fn f():str{missing} fn f():u32{1}',
    'fn f(x:str):str{x+1}',
    'fn f():str{missing} fn g():u32{}',
    'fn f(x:str):u32{x} fn g():u32{missing}',
    'fn f(x:u32,x:str):str{x}',
    'fn f():u32{"日本語"+1}',
    'fn a():u32{1 fn b():u32{2 fn c():u32{3',
    '/* unterminated', '',
    'fn f():str{1} fn g(x:str):u32{x+1}',
  ];
  const expected=sources.map(parseModuleReference);
  assert.equal(expected[2].diagnostic?.code,E.EUndefinedName);
  assert.equal(expected[3].diagnostic?.code,E.ETypeMismatch);
  assert.equal(expected[4].diagnostic?.code,E.EExpectedOperand);
  assert.equal(expected[5].diagnostic?.code,E.EUndefinedName);
  assert.equal(expected[11].diagnostic?.code,E.EReturnType);
  for(const diagnostics of strategies) {
    const results=parseGpuModules(sources,7,3,{diagnostics});
    results.forEach((actual,i)=> {
      assert.deepEqual(actual.tokens,expected[i].tokens,sources[i]);
      assert.deepEqual(actual.nodes,expected[i].nodes,sources[i]);
      assert.deepEqual(actual.functions,expected[i].functions,sources[i]);
      assert.deepEqual(actual.diagnostic,expected[i].diagnostic,sources[i]);
      assert.equal(actual.diagnostics,diagnostics);
      assert.equal(actual.mslVersion,'4.0');
      assert.equal(actual.hostWaits,1);
    });
  }
});

test('reduced diagnostics cover partial groups, error storms and the maximum EOF offset',()=> {
  const sources=[...Array.from({length:4},(_,i)=>' '.repeat(254+i)+'1+'),
    '@'.repeat(65537), '/*'+' '.repeat(1048576-2)];
  for(const diagnostics of strategies) {
    const results=parseGpuBatch(sources,64,1,{diagnostics});
    results.forEach((actual,i)=> {
      assert.deepEqual(actual.diagnostic,parseReference(sources[i]).diagnostic);
      assert.deepEqual(actual.nodes,[]);
      assert.equal(actual.root,null);
      assert.equal(actual.hostWaits,1);
    });
    assert.deepEqual(results.at(-1)!.diagnostic,{code:E.EUnterminatedComment,offset:1048576});
  }
});

test('new diagnostic schedules reduce dispatches without changing the AST',()=> {
  const source=Array.from({length:128},(_,i)=>`fn f${i}(x:u32):u32{(x+${i})*3}`).join('\n');
  const results=strategies.map(diagnostics=>parseGpuModules([source],64,1,{diagnostics})[0]);
  const baseline=results[0];
  for(const actual of results.slice(1)) {
    assert.deepEqual(actual.nodes,baseline.nodes);
    assert.deepEqual(actual.functions,baseline.functions);
    assert.equal(actual.diagnostic,null);
    assert.ok(actual.diagnosticDispatches<baseline.diagnosticDispatches);
    assert.ok(actual.dispatches<baseline.dispatches);
  }
});

test('invalid diagnostic strategy is rejected before invoking Metal',()=> {
  assert.throws(()=>parseGpuBatch(['1'],64,1,{diagnostics:'unknown' as 'tree'}),TypeError);
});
