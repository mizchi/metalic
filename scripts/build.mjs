import { mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generate } from './generate.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
generate();
mkdirSync(`${root}build`,{recursive:true});
const output=`${root}build/frontend-metal`;
const inputs=['native/main.mm','native/contract.h','native/passes.h','native/buffers.h','native/arena.h','native/flight.h','native/batch.h','native/feedback.h'];
const timestamp=(path)=> { try{return statSync(path).mtimeMs;}catch{return 0;} };
for(const [target,flags] of [[output,[]],[`${root}build/frontend-feedback`,['-DMETALIC_FEEDBACK_EXPERIMENT=1']]]) {
  if(inputs.some(path=>timestamp(`${root}${path}`)>timestamp(target))) {
    execFileSync('xcrun',['clang++','-O3','-std=c++17','-fobjc-arc','-Wall','-Wextra',...flags,
      '-framework','Foundation','-framework','Metal',`${root}native/main.mm`,'-o',target],{stdio:'inherit'});
  }
}
console.log(output);
