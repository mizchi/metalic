// contract.h is prepended by the host before compiling this source.
constant uint NONE = 0xffffffffu;
bool digit(uchar c) { return c >= '0' && c <= '9'; }
bool head(uchar c) { return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
bool tail(uchar c) { return head(c) || digit(c); }
bool space(uchar c) { return c == ' ' || (c >= 9 && c <= 13); }
uint base_state(uchar c) {
  return head(c) ? SName : digit(c) ? SNumber : c == '/' ? SSlash : c == '"' ? SString : SBase;
}
uint transition(uint s, uchar c) {
  switch (s) {
    case SName: return tail(c) ? SName : base_state(c);
    case SNumber: return digit(c) ? SNumber : base_state(c);
    case SSlash: return c == '/' ? SLine : c == '*' ? SBlock : base_state(c);
    case SLine: return c == '\n' || c == '\r' ? SBase : SLine;
    case SBlock: return c == '*' ? SBlockStar : SBlock;
    case SBlockStar: return c == '/' ? SBase : c == '*' ? SBlockStar : SBlock;
    case SString: return c == '\\' ? SEscape : c == '"' ? SBase : SString;
    case SEscape: return SString;
    default: return base_state(c);
  }
}
uint token_kind(uchar c) {
  if (digit(c)) return TInteger;
  if (head(c)) return TName;
  switch(c) {
    case '"': return TString;
    case '+': return TPlus; case '-': return TMinus;
    case '*': return TStar; case '/': return TSlash;
    case '(': return TLParen; case ')': return TRParen;
    case ';': return TSemicolon; case ':': return TColon; case ',': return TComma;
    case '{': return TLBrace; case '}': return TRBrace; default: return TInvalid;
  }
}
void error(device uint* m, constant Params& p, uint at, uint code) {
  // Independent functions can diagnose the same EOF byte concurrently.
  device atomic_uint* slot=reinterpret_cast<device atomic_uint*>(m+p.l.errors+at);
  uint old=atomic_load_explicit(slot,memory_order_relaxed);
  while ((old==0 || code<old) && !atomic_compare_exchange_weak_explicit(
    slot,&old,code,memory_order_relaxed,memory_order_relaxed)) {}
}

// Each chunk summarizes its effect for EVERY possible entry state.
kernel void lex_summarize(device const uchar* s [[buffer(0)]],
  device uint* m [[buffer(1)]], constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if (i >= p.size) return;
  for (uint entry = 0; entry < SCount; ++entry) {
    uint state = entry;
    for (uint j = i*p.chunk; j < min((i+1)*p.chunk,p.n); ++j) state=transition(state,s[j]);
    m[p.a + entry*p.size + i] = state;
  }
}
kernel void lex_compose(device const uchar* s [[buffer(0)]],
  device uint* m [[buffer(1)]], constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if (i >= p.size) return;
  for (uint entry = 0; entry < SCount; ++entry) {
    uint intermediate = i >= p.step ? m[p.a + entry*p.size + i-p.step] : entry;
    m[p.b + entry*p.size + i] = m[p.a + intermediate*p.size + i];
  }
}
kernel void lex_mark(device const uchar* s [[buffer(0)]],
  device uint* m [[buffer(1)]], constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if (i >= p.size) return;
  uint state=i==0 ? SBase : m[p.a + (i-1)];
  for (uint j=i*p.chunk; j<min((i+1)*p.chunk,p.n); ++j) {
    uchar c=s[j], next=j+1<p.n ? s[j+1] : uchar(0);
    bool fresh=state==SBase || (state==SName && !tail(c)) ||
      (state==SNumber && !digit(c)) || (state==SSlash && c!='/' && c!='*');
    bool start=fresh && !space(c) && !(c=='/' && (next=='/' || next=='*'));
    uint kind=token_kind(c), after=transition(state,c);
    bool end=(start && kind>=TPlus) || (after==SName && !tail(next)) ||
      (after==SNumber && !digit(next)) || (state==SString && c=='"');
    m[p.l.starts+j]=start;
    m[p.l.ends+j]=end;
    if (start && kind==TInvalid) error(m,p,j,EInvalidCharacter);
    if ((state==SString || state==SEscape) && (c=='\n' || c=='\r')) error(m,p,j,EUnterminatedString);
    state=after;
  }
  if (i+1==p.size) {
    if (state==SString || state==SEscape) error(m,p,p.n,EUnterminatedString);
    if (state==SBlock || state==SBlockStar) error(m,p,p.n,EUnterminatedComment);
  }
}

// Work-efficient global scan: local shared-memory scans, recursively scanned
// group totals, then one offset-add dispatch. Host knows capacity, not counts.
kernel void scan_blocks(device const uchar* s [[buffer(0)]],
  device uint* m [[buffer(1)]], constant Params& p [[buffer(2)]],
  uint i [[thread_position_in_grid]], uint t [[thread_index_in_threadgroup]],
  uint group [[threadgroup_position_in_grid]]) {
  threadgroup uint values[256];
  uint identity=p.d ? NONE : 0;
  values[t]=i<p.size ? m[p.a+i] : identity;
  threadgroup_barrier(mem_flags::mem_threadgroup);
  for (uint stride=1;stride<256;stride*=2) {
    uint other=t>=stride ? values[t-stride] : identity;
    uint v=p.d ? min(values[t],other) : values[t]+other;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    values[t]=v;
    threadgroup_barrier(mem_flags::mem_threadgroup);
  }
  if (i<p.size) m[p.b+i]=values[t];
  if (t==255) m[p.c+group]=values[t];
}
kernel void scan_add(device const uchar* s [[buffer(0)]],
  device uint* m [[buffer(1)]], constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if (i<p.size && i/256>0) m[p.a+i]=p.d ? min(m[p.a+i],m[p.b+i/256-1]) : m[p.a+i]+m[p.b+i/256-1];
}
kernel void tokenize(device const uchar* s [[buffer(0)]],
  device uint* m [[buffer(1)]], constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if (i==0) m[p.l.control+CTokenCount]=p.n ? m[p.l.ranks+p.n-1] : 0;
  if (i>=p.n) return;
  uint rank=m[p.l.ranks+i];
  if (m[p.l.starts+i]) {
    uint j=rank-1;
    m[p.l.tokKind+j]=token_kind(s[i]); m[p.l.tokBegin+j]=i;
  }
  // No start can share a token index with another start. End writes use their
  // own column; missing string terminators retain the initialized source end.
  if (m[p.l.ends+i] && rank) m[p.l.tokEnd+rank-1]=i+1;
}
kernel void paren_deltas(device const uchar* s [[buffer(0)]],
  device uint* m [[buffer(1)]], constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if (i>=p.size) return;
  uint k=i<m[p.l.control+CTokenCount] && (!p.mode || m[p.l.active+i]) ? m[p.l.tokKind+i] : 0;
  m[p.l.delta+i]= k==TLParen ? 1 : k==TRParen ? uint(-1) : 0;
}
bool value_token(uint k) { return (k>=TInteger && k<=TString) || k==TRParen; }
kernel void validate_structure(device const uchar* s [[buffer(0)]],
  device uint* m [[buffer(1)]], constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  uint count=m[p.l.control+CTokenCount];
  if (i==0 && !p.mode) {
    uint last=count ? m[p.l.tokKind+count-1] : 0;
    if (!value_token(last) && last!=TSemicolon) error(m,p,p.n,EExpectedOperand);
    if (int(m[p.l.depth+p.size-1])>0) error(m,p,p.n,EUnclosedParen);
  }
  if (i>=count || (p.mode && !m[p.l.active+i])) return;
  uint k=m[p.l.tokKind+i], at=m[p.l.tokBegin+i];
  uint depth=m[p.l.depth+i];
  if(p.mode) {
    uint f=m[p.l.fnRanks+i]-1, begin=m[p.l.fnBodyBegin+f];
    depth-=begin ? m[p.l.depth+begin-1] : 0;
    if(k==TSemicolon && i+1<m[p.l.fnBodyEnd+f]) error(m,p,at,EFunctionSyntax);
  }
  if(k>=TInvalid) error(m,p,at,EFunctionSyntax);
  bool after=i>0 && value_token(m[p.l.tokKind+i-1]);
  if (((k>=TInteger && k<=TString) || k==TLParen) && after) error(m,p,at,EExpectedOperator);
  if ((k==TStar || k==TSlash || k==TRParen || k==TSemicolon) && !after) error(m,p,at,EExpectedOperand);
  if (k==TRParen && int(depth)<0) error(m,p,at,EUnexpectedClose);
  if (k==TSemicolon && depth!=0) error(m,p,at,ESemicolonInParen);
}
kernel void normalize_operators(device const uchar* s [[buffer(0)]],
  device uint* m [[buffer(1)]], constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if (i>=p.size) return;
  uint count=m[p.l.control+CTokenCount];
  uint k=i<count && (!p.mode || m[p.l.active+i]) ? m[p.l.tokKind+i] : 0;
  m[p.l.nodeFlags+i]=(k>=TInteger && k<=TSlash) || (!p.mode && k==TSemicolon && i+1<count);
}
kernel void scatter_nodes(device const uchar* s [[buffer(0)]],
  device uint* m [[buffer(1)]], constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if (i==0) m[p.l.control+CNodeCount]=m[p.l.nodeRanks+p.size-1];
  if (i>=p.size || !m[p.l.nodeFlags+i]) return;
  uint j=m[p.l.nodeRanks+i]-1, k=m[p.l.tokKind+i];
  bool unary=i==0 || !value_token(m[p.l.tokKind+i-1]);
  uint nk=k<=TString ? k : k==TPlus ? (unary ? NPos : NAdd) :
    k==TMinus ? (unary ? NNeg : NSub) : k==TStar ? NMul : k==TSlash ? NDiv : NSequence;
  uint begin=m[p.l.tokBegin+i], end=m[p.l.tokEnd+i], value=0;
  if (k==TInteger) {
    for (uint b=begin;b<end;++b) {
      uint d=s[b]-'0';
      if (value>429496729u || (value==429496729u && d>5)) { error(m,p,begin,EIntegerOverflow); break; }
      value=value*10+d;
    }
  }
  m[p.l.tokenNode+i]=j; m[p.l.nodeToken+j]=i; m[p.l.nodeKind+j]=nk;
  m[p.l.nodeDepth+j]=m[p.l.depth+i]; m[p.l.nodeValue+j]=value;
  m[p.l.nodeBegin+j]=begin; m[p.l.nodeEnd+j]=end;
  if(p.mode) m[p.l.nodeOwner+j]=m[p.l.fnRanks+i]-1;
}

uint precedence(uint kind) {
  return kind==NSequence ? 0 : kind==NAdd || kind==NSub ? 1 :
    kind==NMul || kind==NDiv ? 2 : kind==NNeg || kind==NPos ? 3 : 4;
}
bool less_key(device const uint* m, constant Params& p, uint a, uint b) {
  if (a==NONE) return false;
  if (b==NONE) return true;
  uint da=m[p.l.nodeDepth+a], db=m[p.l.nodeDepth+b];
  if (da!=db) return da<db;
  uint pa=precedence(m[p.l.nodeKind+a]), pb=precedence(m[p.l.nodeKind+b]);
  if (pa!=pb) return pa<pb;
  return pa==3 ? a<b : a>b; // prefix right associative; binary left associative
}
kernel void rmq_seed(device const uchar* s [[buffer(0)]],
  device uint* m [[buffer(1)]], constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if (i>=p.size) return;
  m[p.l.tree+p.a+i]=i<m[p.l.control+CNodeCount] ? i : NONE;
}
kernel void rmq_level(device const uchar* s [[buffer(0)]],
  device uint* m [[buffer(1)]], constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if (i>=p.size) return;
  uint j=p.a+i, a=m[p.l.tree+2*j], b=m[p.l.tree+2*j+1];
  m[p.l.tree+j]=less_key(m,p,a,b) ? a : b;
}
// Segment-tree range minima let each node find its nearest smaller neighbors
// in O(log capacity), including adversarial deep/skewed expressions.
uint neighbor(device const uint* m, constant Params& p, uint id, bool leftward) {
  uint current=p.a+id, found=0;
  while (current>1) {
    bool eligible=leftward ? (current&1)!=0 : (current&1)==0;
    if (eligible) {
      uint sibling=leftward ? current-1 : current+1;
      if (less_key(m,p,m[p.l.tree+sibling],id)) { found=sibling; break; }
    }
    current/=2;
  }
  if (!found) return NONE;
  while (found<p.a) {
    uint preferred=2*found+(leftward ? 1 : 0);
    if (less_key(m,p,m[p.l.tree+preferred],id)) found=preferred;
    else found=leftward ? preferred-1 : preferred+1;
  }
  return m[p.l.tree+found];
}
// Search the same tree within a function's interval. Partial subtrees must be
// descended even when their global minimum belongs to another function.
uint scoped_neighbor(device const uint* m, constant Params& p, uint id, bool leftward, uint lo, uint hi) {
  if(lo>=hi) return NONE;
  uint node=1;
  while(true) {
    uint depth=31-clz(node), width=p.a>>depth;
    uint begin=(node-(1u<<depth))*width, end=begin+width;
    bool overlap=begin<hi && end>lo;
    bool inside=begin>=lo && end<=hi;
    if(overlap && (!inside || less_key(m,p,m[p.l.tree+node],id))) {
      if(node>=p.a) return m[p.l.tree+node];
      node=2*node+(leftward ? 1 : 0);
      continue;
    }
    while(node>1 && (leftward ? (node&1)==0 : (node&1)!=0)) node/=2;
    if(node==1) return NONE;
    node=leftward ? node-1 : node+1;
  }
}
kernel void build_ast(device const uchar* s [[buffer(0)]],
  device uint* m [[buffer(1)]], constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if (i>=m[p.l.control+CNodeCount] || (p.mode && m[p.l.control+CErrorCode])) return;
  uint l,r,owner=0;
  if(p.mode) {
    owner=m[p.l.nodeOwner+i];
    uint begin=m[p.l.fnBodyBegin+owner], end=m[p.l.fnBodyEnd+owner];
    uint lo=begin ? m[p.l.nodeRanks+begin-1] : 0, hi=m[p.l.nodeRanks+end-1];
    l=scoped_neighbor(m,p,i,true,lo,i); r=scoped_neighbor(m,p,i,false,i+1,hi);
  } else { l=neighbor(m,p,i,true); r=neighbor(m,p,i,false); }
  uint parent=l==NONE ? r : r==NONE ? l : less_key(m,p,l,r) ? r : l;
  m[p.l.parent+i]=parent;
  if (parent==NONE) { if(p.mode) m[p.l.fnRoot+owner]=i; else m[p.l.control+CRoot]=i; }
  else if (i<parent) m[p.l.left+parent]=i;
  else m[p.l.right+parent]=i;
}
kernel void validate_ast(device const uchar* s [[buffer(0)]],
  device uint* m [[buffer(1)]], constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  uint count=m[p.l.control+CNodeCount];
  if (i>=count || m[p.l.control+CErrorCode]) return;
  uint kind=m[p.l.nodeKind+i], l=m[p.l.left+i], r=m[p.l.right+i];
  bool leaf=kind<=NString, unary=kind==NNeg || kind==NPos;
  bool ok=leaf ? l==NONE && r==NONE : unary ? l==NONE && r<count : l<count && r<count;
  if (l<count && m[p.l.parent+l]!=i) ok=false;
  if (r<count && m[p.l.parent+r]!=i) ok=false;
  if (!ok) error(m,p,m[p.l.nodeBegin+i],EInvalidAst);
}

kernel void error_seed(device const uchar* s [[buffer(0)]],
  device uint* m [[buffer(1)]], constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if (i<p.size) m[p.l.tree+p.a+i]=i<=p.n && m[p.l.errors+i] ? i : NONE;
}
kernel void error_level(device const uchar* s [[buffer(0)]],
  device uint* m [[buffer(1)]], constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if (i<p.size) { uint j=p.a+i; m[p.l.tree+j]=min(m[p.l.tree+2*j],m[p.l.tree+2*j+1]); }
}
kernel void error_publish(device const uchar* s [[buffer(0)]],
  device uint* m [[buffer(1)]], constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if (i) return;
  uint at=m[p.l.tree+1];
  m[p.l.control+CErrorOffset]=at;
  m[p.l.control+CErrorCode]=at==NONE ? 0 : m[p.l.errors+at];
}
