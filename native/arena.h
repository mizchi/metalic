#pragma once

struct ArenaPlan {
  U32 next=0,limit=0;
  U32 take(U32 count) {
    U32 at=next; next+=count;
    if(limit && next>limit) throw std::runtime_error("Arena planning overflow");
    return at;
  }
};

struct ArenaReset {
  U32* memory;
  size_t bytes=0;
  void zero(U32 offset,U32 count) {
    memset(memory+offset,0,size_t(count)*sizeof(U32)); bytes+=size_t(count)*sizeof(U32);
  }
  void fill(U32 offset,U32 count,U32 value) {
    std::fill(memory+offset,memory+offset+count,value); bytes+=size_t(count)*sizeof(U32);
  }
};

inline size_t initializeArena(U32* memory,const Layout& l,U32 n,U32 cap,U32 total,
    bool moduleMode,DiagnosticStrategy diagnostics,bool selective) {
  ArenaReset reset{memory};
  if(!selective) reset.zero(0,total);
  else {
    reset.zero(l.control,CCount);
    // All n source positions are written by lex_mark. Empty input still scans
    // a single capacity element, so its flags must be explicitly initialized.
    if(!n) { reset.zero(l.starts,1); reset.zero(l.ends,1); }
    if(diagnostics!=DPacked) reset.zero(l.errors,n+1);
    if(moduleMode) { reset.zero(l.active,cap); reset.zero(l.fnValid,MaxFunctions); }
  }
  reset.fill(l.tokEnd,cap,n); // Unterminated strings retain the source end.
  reset.fill(l.left,cap,NONE); reset.fill(l.right,cap,NONE);
  if(!selective) reset.fill(l.parent,cap,NONE); // build_ast overwrites every live parent.
  if(moduleMode) {
    reset.fill(l.nodeBinding,cap,NONE);
    if(!selective) reset.fill(l.nodeOwner,cap,NONE); // scatter_nodes writes live owners.
    reset.fill(l.fnRoot,MaxFunctions,NONE);
  }
  reset.fill(l.control+CRoot,1,NONE); reset.fill(l.control+CErrorOffset,1,NONE);
  reset.fill(l.control+CGrammarKey,3,NONE);
  // Maps, ranks, node fields, tree and scan scratch are written before read.
  return reset.bytes;
}
