// Independent CPU oracle: sequential byte lexer + iterative shunting-yard.
// It does not implement the GPU transition-summary / Cartesian-tree algorithms.
import { TokenKind as T, NodeKind as N, ErrorCode as E } from './contract.ts';
import type { Token, AstNode, Diagnostic, ParseResult } from './contract.ts';

const digit = (c: number) => c >= 48 && c <= 57;
const head = (c: number) => c === 95 || c >= 65 && c <= 90 || c >= 97 && c <= 122;
const tail = (c: number) => head(c) || digit(c);
const space = (c: number) => c === 32 || c >= 9 && c <= 13;
const symbols = new Map([[43,T.TPlus],[45,T.TMinus],[42,T.TStar],[47,T.TSlash],
  [40,T.TLParen],[41,T.TRParen],[59,T.TSemicolon],[58,T.TColon],[44,T.TComma],
  [123,T.TLBrace],[125,T.TRBrace]]);

export function lexReference(source: string, moduleMode=false) {
  const bytes = Buffer.from(source);
  const tokens: Token[] = [], errors: Diagnostic[] = [];
  const fail = (code: Diagnostic['code'], offset: number) => errors.push({code,offset});
  let i = 0;
  while (i < bytes.length) {
    if (space(bytes[i])) { i++; continue; }
    if (bytes[i] === 47 && bytes[i+1] === 47) {
      i += 2; while (i < bytes.length && bytes[i] !== 10 && bytes[i] !== 13) i++; continue;
    }
    if (bytes[i] === 47 && bytes[i+1] === 42) {
      i += 2;
      while (i < bytes.length && !(bytes[i] === 42 && bytes[i+1] === 47)) i++;
      if (i === bytes.length) { fail(E.EUnterminatedComment, i); break; }
      i += 2; continue;
    }
    const begin = i;
    let kind: Token['kind'];
    if (head(bytes[i])) { while (i < bytes.length && tail(bytes[i])) i++; kind=T.TName; }
    else if (digit(bytes[i])) { while (i < bytes.length && digit(bytes[i])) i++; kind=T.TInteger; }
    else if (bytes[i] === 34) {
      i++;
      let closed=false;
      while (i < bytes.length) {
        const c=bytes[i++];
        if (c===10 || c===13) fail(E.EUnterminatedString,i-1);
        if (c===34) { closed=true; break; }
        if (c===92 && i < bytes.length) {
          if (bytes[i]===10 || bytes[i]===13) fail(E.EUnterminatedString,i);
          i++;
        }
      }
      if (!closed) fail(E.EUnterminatedString,bytes.length);
      kind=T.TString;
    } else {
      kind=symbols.get(bytes[i++]) ?? T.TInvalid;
      if (kind===T.TInvalid) fail(E.EInvalidCharacter,begin);
    }
    if(moduleMode && kind===T.TName && bytes.subarray(begin,i).toString()==='fn') kind=T.TFn;
    tokens.push({kind,begin,end:i});
  }
  return {bytes,tokens,errors};
}

export function parseReference(source: string): ParseResult {
  const {bytes,tokens,errors}=lexReference(source);
  return parseExpressionTokens(bytes,tokens,errors);
}

export function parseExpressionTokens(bytes: Buffer, tokens: Token[], priorErrors: Diagnostic[]=[], endOffset=bytes.length): ParseResult {
  const nodes: AstNode[]=[], errors=[...priorErrors];
  const fail=(code: Diagnostic['code'],offset:number)=>errors.push({code,offset});

  // Validate token adjacency and parenthesis balance separately from construction.
  let depth=0;
  for (let j=0;j<tokens.length;j++) {
    const t=tokens[j], prev=tokens[j-1];
    if(t.kind>=T.TInvalid) fail(E.EFunctionSyntax,t.begin);
    const afterValue=prev && (prev.kind<=T.TString || prev.kind===T.TRParen);
    if (t.kind<=T.TString || t.kind===T.TLParen) {
      if (afterValue) fail(E.EExpectedOperator,t.begin);
    } else if (t.kind===T.TStar || t.kind===T.TSlash || t.kind===T.TRParen || t.kind===T.TSemicolon) {
      if (!afterValue) fail(E.EExpectedOperand,t.begin);
    }
    if (t.kind===T.TLParen) depth++;
    if (t.kind===T.TRParen) { depth--; if (depth<0) fail(E.EUnexpectedClose,t.begin); }
    if (t.kind===T.TSemicolon && depth!==0) fail(E.ESemicolonInParen,t.begin);
    if (t.kind===T.TInteger && BigInt(bytes.subarray(t.begin,t.end).toString()) > 0xffff_ffffn)
      fail(E.EIntegerOverflow,t.begin);
  }
  const last=tokens.at(-1);
  if (!last || !(last.kind<=T.TString || last.kind===T.TRParen || last.kind===T.TSemicolon))
    fail(E.EExpectedOperand,endOffset);
  if (depth>0) fail(E.EUnclosedParen,endOffset);

  const diagnostic=errors.sort((a,b)=>a.offset-b.offset || a.code-b.code)[0] ?? null;
  if (diagnostic) return {tokens,nodes:[],root:null,diagnostic};

  const values: number[]=[], operators: number[]=[];
  const prec=(k:number)=>k===N.NSequence ? 0 : k===N.NAdd||k===N.NSub ? 1 : k===N.NMul||k===N.NDiv ? 2 : 3;
  const reduce=()=> {
    const id=operators.pop()!, node=nodes[id];
    node.right=values.pop()!;
    if (node.kind!==N.NNeg && node.kind!==N.NPos) node.left=values.pop()!;
    values.push(id);
  };
  let expectValue=true;
  for (let j=0;j<tokens.length;j++) {
    const t=tokens[j];
    if (t.kind===T.TLParen) { operators.push(-1); expectValue=true; continue; }
    if (t.kind===T.TRParen) {
      while (operators.at(-1)!==-1) reduce();
      operators.pop(); expectValue=false; continue;
    }
    if (t.kind===T.TSemicolon && j===tokens.length-1) continue;
    const kind = t.kind<=T.TString ? t.kind as AstNode['kind']
      : t.kind===T.TPlus ? (expectValue ? N.NPos : N.NAdd)
      : t.kind===T.TMinus ? (expectValue ? N.NNeg : N.NSub)
      : t.kind===T.TStar ? N.NMul : t.kind===T.TSlash ? N.NDiv : N.NSequence;
    const id=nodes.length;
    nodes.push({kind,begin:t.begin,end:t.end,
      value:t.kind===T.TInteger ? Number(bytes.subarray(t.begin,t.end).toString()) : 0,
      left:null,right:null});
    if (t.kind<=T.TString) { values.push(id); expectValue=false; }
    else {
      const unary=kind===N.NNeg||kind===N.NPos;
      while (operators.length && operators.at(-1)!==-1 &&
        (prec(nodes[operators.at(-1)!].kind)>prec(kind) ||
        !unary && prec(nodes[operators.at(-1)!].kind)===prec(kind))) reduce();
      operators.push(id); expectValue=true;
    }
  }
  while (operators.length) reduce();
  return {tokens,nodes,root:values[0],diagnostic:null};
}
