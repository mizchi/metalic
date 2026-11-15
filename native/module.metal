// Function headers are bounded tasks; bodies remain data-parallel token/node IR.
bool token_text(device const uchar* s, device const uint* m, constant Params& p, uint token, constant char* word, uint length) {
  uint begin=m[p.l.tokBegin+token], end=m[p.l.tokEnd+token];
  if(end-begin!=length) return false;
  for(uint i=0;i<length;i++) if(s[begin+i]!=uchar(word[i])) return false;
  return true;
}
bool same_name(device const uchar* s, device const uint* m, constant Params& p, uint a, uint b) {
  uint begin=m[p.l.tokBegin+a], other=m[p.l.tokBegin+b], length=m[p.l.tokEnd+a]-begin;
  if(m[p.l.tokEnd+b]-other!=length) return false;
  for(uint i=0;i<length;i++) if(s[begin+i]!=s[other+i]) return false;
  return true;
}
kernel void mark_functions(device const uchar* s [[buffer(0)]], device uint* m [[buffer(1)]],
  constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if(i>=p.size) return;
  uint k=i<m[p.l.control+CTokenCount] ? m[p.l.tokKind+i] : 0;
  if(k==TName && token_text(s,m,p,i,"fn",2)) { k=TFn; m[p.l.tokKind+i]=k; }
  m[p.l.fnFlags+i]=k==TFn;
  m[p.l.closeInput+p.size-1-i]=k==TRBrace ? i : NONE;
}
kernel void index_functions(device const uchar* s [[buffer(0)]], device uint* m [[buffer(1)]],
  constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if(i>=p.size) return;
  uint count=m[p.l.fnRanks+p.size-1];
  if(i==0) {
    m[p.l.control+CFunctionCount]=count;
    if(!count) error(m,p,p.n,EFunctionSyntax);
    if(count>MaxFunctions) error(m,p,p.n,ECapacity);
  }
  if(m[p.l.fnFlags+i] && m[p.l.fnRanks+i]<=MaxFunctions) m[p.l.fnToken+m[p.l.fnRanks+i]-1]=i;
}
bool expect_header(device uint* m, constant Params& p, thread uint& cursor, uint kind) {
  uint count=m[p.l.control+CTokenCount];
  if(cursor>=count || m[p.l.tokKind+cursor]!=kind) {
    error(m,p,cursor<count ? m[p.l.tokBegin+cursor] : p.n,EFunctionSyntax); return false;
  }
  cursor++; return true;
}
uint header_type(device const uchar* s, device uint* m, constant Params& p, thread uint& cursor) {
  uint token=cursor;
  if(!expect_header(m,p,cursor,TName)) return 0;
  if(token_text(s,m,p,token,"u32",3)) return TypeU32;
  if(token_text(s,m,p,token,"str",3)) return TypeStr;
  error(m,p,m[p.l.tokBegin+token],EUnknownType); return 0;
}
kernel void parse_function_headers(device const uchar* s [[buffer(0)]], device uint* m [[buffer(1)]],
  constant Params& p [[buffer(2)]], uint f [[thread_position_in_grid]]) {
  uint count=m[p.l.control+CFunctionCount];
  if(f>=count || count>MaxFunctions) return;
  uint cursor=m[p.l.fnToken+f], parameters=0;
  if(!expect_header(m,p,cursor,TFn)) return;
  m[p.l.fnName+f]=cursor;
  if(!expect_header(m,p,cursor,TName) || !expect_header(m,p,cursor,TLParen)) return;
  if(cursor>=m[p.l.control+CTokenCount] || m[p.l.tokKind+cursor]!=TRParen) {
    while(true) {
      if(parameters==MaxParameters) {
        error(m,p,cursor<m[p.l.control+CTokenCount] ? m[p.l.tokBegin+cursor] : p.n,ECapacity); return;
      }
      uint token=cursor;
      if(!expect_header(m,p,cursor,TName) || !expect_header(m,p,cursor,TColon)) return;
      uint type=header_type(s,m,p,cursor); if(!type) return;
      m[p.l.fnParams+f*MaxParameters+parameters++]=token; m[p.l.paramType+token]=type;
      if(cursor>=m[p.l.control+CTokenCount] || m[p.l.tokKind+cursor]!=TComma) break;
      cursor++;
    }
  }
  if(!expect_header(m,p,cursor,TRParen) || !expect_header(m,p,cursor,TColon)) return;
  uint returnType=header_type(s,m,p,cursor); if(!returnType) return;
  if(!expect_header(m,p,cursor,TLBrace)) return;
  // A reversed inclusive min scan supplies the first closing brace in O(1).
  uint close=m[p.l.closeRanks+p.a-cursor];
  if(close==NONE) { error(m,p,p.n,EFunctionSyntax); return; }
  m[p.l.fnBodyBegin+f]=cursor; m[p.l.fnBodyEnd+f]=close;
  m[p.l.fnParamCount+f]=parameters; m[p.l.fnReturnType+f]=returnType; m[p.l.fnValid+f]=1;
}
kernel void classify_function_tokens(device const uchar* s [[buffer(0)]], device uint* m [[buffer(1)]],
  constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if(i>=m[p.l.control+CTokenCount] || m[p.l.control+CFunctionCount]>MaxFunctions) return;
  uint rank=m[p.l.fnRanks+i];
  if(!rank) { error(m,p,m[p.l.tokBegin+i],EFunctionSyntax); return; }
  uint f=rank-1;
  // `fn` is a reserved boundary candidate. Reject candidates occurring inside
  // an earlier body before their tentative headers can hide that body error.
  if(m[p.l.fnFlags+i]) for(uint previous=0;previous<f;previous++)
    if(m[p.l.fnValid+previous] && i>=m[p.l.fnBodyBegin+previous] && i<m[p.l.fnBodyEnd+previous])
      error(m,p,m[p.l.tokBegin+i],EFunctionSyntax);
  if(!m[p.l.fnValid+f]) return;
  uint begin=m[p.l.fnBodyBegin+f], end=m[p.l.fnBodyEnd+f];
  m[p.l.active+i]=i>=begin && i<end;
  if(i>end) error(m,p,m[p.l.tokBegin+i],EFunctionSyntax);
}
kernel void validate_function_bodies(device const uchar* s [[buffer(0)]], device uint* m [[buffer(1)]],
  constant Params& p [[buffer(2)]], uint f [[thread_position_in_grid]]) {
  uint count=m[p.l.control+CFunctionCount];
  if(f>=count || count>MaxFunctions || !m[p.l.fnValid+f]) return;
  uint begin=m[p.l.fnBodyBegin+f], end=m[p.l.fnBodyEnd+f], at=m[p.l.tokBegin+end];
  uint last=end>begin ? m[p.l.tokKind+end-1] : 0;
  if(!value_token(last) && last!=TSemicolon) error(m,p,at,EExpectedOperand);
  uint depth=m[p.l.depth+end]-(begin ? m[p.l.depth+begin-1] : 0);
  if(int(depth)>0) error(m,p,at,EUnclosedParen);
}
kernel void resolve_declarations(device const uchar* s [[buffer(0)]], device uint* m [[buffer(1)]],
  constant Params& p [[buffer(2)]], uint f [[thread_position_in_grid]]) {
  if(f>=m[p.l.control+CFunctionCount] || m[p.l.control+CErrorCode]) return;
  uint name=m[p.l.fnName+f];
  for(uint other=0;other<f;other++) if(same_name(s,m,p,name,m[p.l.fnName+other]))
    error(m,p,m[p.l.tokBegin+name],EDuplicateFunction);
  for(uint i=0;i<m[p.l.fnParamCount+f];i++) {
    uint token=m[p.l.fnParams+f*MaxParameters+i];
    for(uint j=0;j<i;j++) if(same_name(s,m,p,token,m[p.l.fnParams+f*MaxParameters+j]))
      error(m,p,m[p.l.tokBegin+token],EDuplicateParameter);
  }
}
kernel void resolve_names(device const uchar* s [[buffer(0)]], device uint* m [[buffer(1)]],
  constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if(i>=m[p.l.control+CNodeCount] || m[p.l.control+CErrorCode] || m[p.l.nodeKind+i]!=NName) return;
  uint f=m[p.l.nodeOwner+i], name=m[p.l.nodeToken+i];
  for(uint j=0;j<m[p.l.fnParamCount+f];j++) {
    uint token=m[p.l.fnParams+f*MaxParameters+j];
    if(same_name(s,m,p,name,token)) { m[p.l.nodeBinding+i]=token; return; }
  }
  error(m,p,m[p.l.nodeBegin+i],EUndefinedName);
}
kernel void seed_types(device const uchar* s [[buffer(0)]], device uint* m [[buffer(1)]],
  constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if(i>=m[p.l.control+CNodeCount] || m[p.l.control+CErrorCode]) return;
  uint kind=m[p.l.nodeKind+i];
  m[p.l.nodeType+i]=kind==NString ? TypeStr : kind==NName ? m[p.l.paramType+m[p.l.nodeBinding+i]] : TypeU32;
}
kernel void check_types(device const uchar* s [[buffer(0)]], device uint* m [[buffer(1)]],
  constant Params& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if(i>=m[p.l.control+CNodeCount] || m[p.l.control+CErrorCode] || m[p.l.nodeKind+i]<NAdd) return;
  uint left=m[p.l.left+i], right=m[p.l.right+i];
  if((left!=NONE && m[p.l.nodeType+left]!=TypeU32) || (right!=NONE && m[p.l.nodeType+right]!=TypeU32))
    error(m,p,m[p.l.nodeBegin+i],ETypeMismatch);
}
kernel void check_returns(device const uchar* s [[buffer(0)]], device uint* m [[buffer(1)]],
  constant Params& p [[buffer(2)]], uint f [[thread_position_in_grid]]) {
  if(f>=m[p.l.control+CFunctionCount] || m[p.l.control+CErrorCode]) return;
  uint root=m[p.l.fnRoot+f];
  if(root>=m[p.l.control+CNodeCount]) error(m,p,m[p.l.tokBegin+m[p.l.fnName+f]],EInvalidAst);
  else if(m[p.l.nodeType+root]!=m[p.l.fnReturnType+f]) error(m,p,m[p.l.nodeBegin+root],EReturnType);
}
