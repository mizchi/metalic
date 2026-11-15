import assert from 'node:assert/strict';
import { existsSync,readFileSync,readdirSync } from 'node:fs';
import { dirname,join,resolve,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root=fileURLToPath(new URL('../',import.meta.url));
for(const path of ['README.md','CONTRIBUTING.md','docs/internal/README.md','docs/internal/metalic-lessons/README.md'])
  assert.ok(existsSync(join(root,path)),`Missing document: ${path}`);
for(const path of ['reports','research_notes','docs/metalic-lessons'])
  assert.ok(!existsSync(join(root,path)),`Internal documents still use the old location: ${path}`);

function markdown(directory) {
  return readdirSync(directory,{withFileTypes:true}).flatMap(e=>e.isDirectory()?markdown(join(directory,e.name)):
    e.name.endsWith('.md')?[join(directory,e.name)]:[]);
}
const files=['README.md','CONTRIBUTING.md','AGENTS.md'].map(p=>join(root,p)).concat(markdown(join(root,'docs')));
let links=0;
for(const file of files) {
  // Example code is not a document link; preserve raw/archived content verbatim.
  const text=readFileSync(file,'utf8').replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm,'');
  for(const [,angle,bare] of text.matchAll(/\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g)) {
    const target=angle??bare;
    if(target.startsWith('#')||/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    const path=decodeURIComponent(target.split('#')[0]);
    if(!path) continue;
    assert.ok(existsSync(resolve(dirname(file),path)),`${relative(root,file)}: missing reference ${target}`);
    links++;
  }
}
console.log(`Documentation links: ${links} local references in ${files.length} Markdown files, OK`);
const evidence=spawnSync(process.execPath,['docs/internal/metalic-lessons/examples/verify-evidence.mjs','--check-prose'],
  {cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
assert.equal(evidence.status,0,`${evidence.stdout}\n${evidence.stderr}`);
console.log(evidence.stdout.split('\n').filter(s=>/^(Fit:|All decisions:|Document references)/.test(s)).join('\n'));
console.log('Documentation: OK');
