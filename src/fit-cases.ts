import type { WorkloadSpec } from './contract.ts';

/** Hypotheses for coverage, never inputs to the placement policy. */
export const fitCases:readonly {name:string;hypothesis:'cpu'|'gpu'|'crossover';spec:WorkloadSpec;placement:'cpu'|'resident'}[]=[
  {name:'tea-small',hypothesis:'cpu',spec:{algorithm:'tea32',count:64},placement:'cpu'},
  {name:'tea-large',hypothesis:'gpu',spec:{algorithm:'tea32',count:1048576},placement:'cpu'},
  {name:'tea-resident',hypothesis:'gpu',spec:{algorithm:'tea32',count:1048576},placement:'resident'},
  {name:'dependent-walk',hypothesis:'cpu',spec:{algorithm:'pointer-chase',count:16384},placement:'cpu'},
  {name:'compact',hypothesis:'cpu',spec:{algorithm:'compact-u32',count:1048576},placement:'cpu'},
  {name:'histogram-hot',hypothesis:'cpu',spec:{algorithm:'histogram256',count:16777216,distribution:'hot'},placement:'cpu'},
  {name:'histogram-balanced',hypothesis:'crossover',spec:{algorithm:'histogram256',count:16777216},placement:'resident'},
  {name:'merkle',hypothesis:'crossover',spec:{algorithm:'merkle-sha256',count:262144},placement:'cpu'},
];
