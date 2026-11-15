import type { TokenKind, NodeKind, ErrorCode, TypeKind } from './schema.ts';
export { TokenKind, NodeKind, ErrorCode, TypeKind } from './schema.ts';

/** All offsets are UTF-8 byte offsets; node spans identify the defining token. */
export interface Token { kind: TokenKind; begin: number; end: number }
export interface AstNode {
  kind: NodeKind; begin: number; end: number; value: number;
  left: number | null; right: number | null;
}
export interface ModuleNode extends AstNode { functionId: number; binding: number | null; type: TypeKind }
export interface Diagnostic { code: ErrorCode; offset: number }
export const passes = ['Lex', 'Tokenize', 'Structure', 'NormalizeOperators', 'BuildAst', 'ValidateAst'] as const;
export const modulePasses = [...passes, 'ResolveNames', 'CheckTypes'] as const;
export interface Parameter { binding: number; begin: number; end: number; type: TypeKind }
export interface FunctionDecl {
  begin: number; end: number; parameters: Parameter[]; returnType: TypeKind; body: number;
}
export interface ParseResult {
  tokens: Token[]; nodes: AstNode[]; root: number | null;
  diagnostic: Diagnostic | null;
}
export interface GpuResult extends ParseResult {
  backend: 'metal'; device: string; passes: readonly string[];
  dispatches: number; hostWaits: number; elapsedUs: number; gpuUs: number;
  chunkSize: number; setupUs: number; arenaBytes: number;
  samplesUs: number[]; gpuSamplesUs: number[];
}
export interface ModuleResult extends ParseResult { nodes: ModuleNode[]; functions: FunctionDecl[] }
export interface GpuModuleResult extends GpuResult { nodes: ModuleNode[]; functions: FunctionDecl[] }
