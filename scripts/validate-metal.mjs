import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseReference } from '../src/reference.ts';
import { parseModuleReference } from '../src/module-reference.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const sources=['a+b*c', '('.repeat(1024)+'name'+')'.repeat(1024),
  Array.from({length:2048},(_,i)=>`v${i}*${i}`).join('+'), '/* bad'];
const moduleSources=['fn f(x:u32):u32{(x+1)*2}', 'fn f(x:str):str{x}',
  Array.from({length:256},(_,i)=>`fn f${i}(x:u32):u32{x+${i}}`).join(' '),
  '', 'fn f():u32{}', 'fn f():u32{missing}', 'fn f():str{1}',
  'fn f():u32{fn g():u32{1}', 'fn f(x:u32):u32{(x}',
  'fn f():str{missing} fn f():u32{1}', 'fn f():str{missing} fn g():u32{}',
  `fn f(${Array.from({length:65},(_,i)=>`p${i}:u32`).join(',')}):u32{p0}`,
  'fn recovered(x:str):str{x}'];
for(const [language,inputs,oracle] of [['expression',sources,parseReference],['module',moduleSources,parseModuleReference]]) {
  for(const diagnostics of ['tree','hierarchical','packed']) {
    const result=spawnSync(`${root}build/frontend-metal`,[`${root}native`],{
      input:JSON.stringify({sources:inputs,chunkSize:7,language,diagnostics,
        buffers:['fresh','reuse','selective'],poisonBuffers:true}),encoding:'utf8',maxBuffer:32*1024*1024,
      env:{...process.env,MTL_DEBUG_LAYER:'1',MTL_SHADER_VALIDATION:'1'},
    });
    assert.equal(result.status,0,result.stderr);
    assert.doesNotMatch(result.stderr,/error|fault|out.of.bounds|invalid (?:access|resource)/i);
    const parsed=JSON.parse(result.stdout);
    assert.equal(parsed.length,inputs.length*3);
    parsed.forEach((actual,i)=> {
      assert.equal(actual.buffers,['fresh','reuse','selective'][i%3]);
      const source=inputs[Math.floor(i/3)],expected=oracle(source);
      assert.deepEqual(actual.diagnostic,expected.diagnostic,source.slice(0,80));
      assert.deepEqual(actual.nodes,expected.nodes);
      if(language==='module') assert.deepEqual(actual.functions,expected.functions);
    });
    console.log(result.stderr.trim());
    console.log(`Metal validation (${language}/${diagnostics}): ${parsed.length} executions across three buffer modes, no reported validation errors`);
  }
}
