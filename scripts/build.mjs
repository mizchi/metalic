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
const workloadInputs=['native/workloads.mm','native/workload-worker.mm','native/workloads_runtime.h','native/workloads_cpu.h',
  'native/workloads_plan.h','native/contract.h','native/buffers.h','scripts/build.mjs'];
for(const [binary,source] of [['workloads-metal','workloads.mm'],['workload-worker','workload-worker.mm']]) {
  const target=`${root}build/${binary}`;
  if(workloadInputs.some(path=>timestamp(`${root}${path}`)>timestamp(target))) {
    execFileSync('xcrun',['clang++','-O3','-std=c++17','-fobjc-arc','-Wall','-Wextra',
      '-framework','Foundation','-framework','Metal',`${root}native/${source}`,'-o',target],{stdio:'inherit'});
  }
}
console.log(output);
