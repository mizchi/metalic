import { TokenKind as T, NodeKind as N, ErrorCode as E, TypeKind as K } from './contract.ts';
import type { ModuleResult, ModuleNode, FunctionDecl, Parameter, Diagnostic, Token, TypeKind } from './contract.ts';
import { lexReference, parseExpressionTokens } from './reference.ts';

class InvalidHeader extends Error {
  diagnostic: Diagnostic;
  constructor(code: Diagnostic['code'],offset:number) { super('Invalid function header'); this.diagnostic={code,offset}; }
}

export function parseModuleReference(source: string): ModuleResult {
  const {bytes,tokens,errors}=lexReference(source,true);
  const nodes: ModuleNode[]=[], functions: FunctionDecl[]=[];
  const fail=(code: Diagnostic['code'],offset:number)=>errors.push({code,offset});
  const first=()=>errors.sort((a,b)=>a.offset-b.offset || a.code-b.code)[0] ?? null;
  const failed=():ModuleResult=>({tokens,nodes:[],root:null,functions:[],diagnostic:first()});
  const text=(t:{begin:number;end:number})=>bytes.subarray(t.begin,t.end).toString();
  if(tokens.filter(t=>t.kind===T.TFn).length>256) { fail(E.ECapacity,bytes.length); return failed(); }
  let cursor=0;
  const expect=(kind:Token['kind'])=> {
    const t=tokens[cursor];
    if(!t || t.kind!==kind) throw new InvalidHeader(E.EFunctionSyntax,t?.begin ?? bytes.length);
    cursor++; return t;
  };
  const type=():TypeKind=> {
    const t=expect(T.TName), value=text(t);
    if(value==='u32') return K.TypeU32;
    if(value==='str') return K.TypeStr;
    throw new InvalidHeader(E.EUnknownType,t.begin);
  };
  try {
    if(!tokens.length) throw new InvalidHeader(E.EFunctionSyntax,bytes.length);
    while(cursor<tokens.length) {
      expect(T.TFn);
      const name=expect(T.TName);
      expect(T.TLParen);
      const parameters:Parameter[]=[];
      if(tokens[cursor]?.kind!==T.TRParen) {
        for(;;) {
          if(parameters.length===64) throw new InvalidHeader(E.ECapacity,tokens[cursor]?.begin ?? bytes.length);
          const binding=cursor, p=expect(T.TName);
          expect(T.TColon);
          parameters.push({binding,begin:p.begin,end:p.end,type:type()});
          if(tokens[cursor]?.kind!==T.TComma) break;
          cursor++;
        }
      }
      expect(T.TRParen); expect(T.TColon);
      const returnType=type();
      expect(T.TLBrace);
      const begin=cursor;
      while(cursor<tokens.length && tokens[cursor].kind!==T.TRBrace) cursor++;
      const close=expect(T.TRBrace), bodyTokens=tokens.slice(begin,cursor-1);
      for(let i=0;i<bodyTokens.length-1;i++) if(bodyTokens[i].kind===T.TSemicolon)
        fail(E.EFunctionSyntax,bodyTokens[i].begin);
      const body=parseExpressionTokens(bytes,bodyTokens,[],close.begin), base=nodes.length;
      if(body.diagnostic) errors.push(body.diagnostic);
      const functionId=functions.length;
      for(const node of body.nodes) nodes.push({...node,functionId,binding:null,type:K.TypeU32,
        left:node.left===null ? null : node.left+base,
        right:node.right===null ? null : node.right+base});
      functions.push({begin:name.begin,end:name.end,parameters,returnType,body:base+(body.root??0)});
    }
  } catch(error) {
    if(!(error instanceof InvalidHeader)) throw error;
    errors.push(error.diagnostic);
  }
  if(errors.length) return failed();

  const scopes=functions.map((fn,index)=> {
    if(functions.slice(0,index).some(prev=>text(prev)===text(fn))) fail(E.EDuplicateFunction,fn.begin);
    const scope=new Map<string,Parameter>();
    for(const p of fn.parameters) {
      if(scope.has(text(p))) fail(E.EDuplicateParameter,p.begin);
      else scope.set(text(p),p);
    }
    return scope;
  });
  for(const node of nodes) if(node.kind===N.NName) {
    const parameter=scopes[node.functionId!].get(text(node));
    if(!parameter) fail(E.EUndefinedName,node.begin);
    else node.binding=parameter.binding;
  }
  if(errors.length) return failed();

  const bindings=new Map(functions.flatMap(fn=>fn.parameters.map(p=>[p.binding,p.type] as const)));
  for(const node of nodes) node.type=node.kind===N.NString ? K.TypeStr
    : node.kind===N.NName ? bindings.get(node.binding!)! : K.TypeU32;
  for(const node of nodes) if(node.kind>=N.NAdd) {
    if((node.left!==null && nodes[node.left].type!==K.TypeU32) ||
       (node.right!==null && nodes[node.right].type!==K.TypeU32)) fail(E.ETypeMismatch,node.begin);
  }
  for(const fn of functions) if(nodes[fn.body].type!==fn.returnType) fail(E.EReturnType,nodes[fn.body].begin);
  if(errors.length) return failed();
  return {tokens,nodes,root:null,functions,diagnostic:null};
}
