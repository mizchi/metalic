// Canonical ABI: TypeScript names are generated from these explicit enums.
#ifndef __METAL_VERSION__
#include <cstdint>
using U32 = uint32_t;
#else
using U32 = uint;
#endif

enum TokenKind : U32 {
  TInteger = 1, TName = 2, TString = 3, TPlus = 4, TMinus = 5,
  TStar = 6, TSlash = 7, TLParen = 8, TRParen = 9, TSemicolon = 10,
  TInvalid = 11, TColon = 12, TComma = 13, TLBrace = 14,
  TRBrace = 15, TFn = 16
};
enum NodeKind : U32 {
  NInteger = 1, NName = 2, NString = 3, NAdd = 4, NSub = 5,
  NMul = 6, NDiv = 7, NNeg = 8, NPos = 9, NSequence = 10
};
enum ErrorCode : U32 {
  EInvalidCharacter = 1, EUnterminatedString = 2, EUnterminatedComment = 3,
  EIntegerOverflow = 4, EExpectedOperand = 5, EExpectedOperator = 6,
  EUnexpectedClose = 7, EUnclosedParen = 8, ESemicolonInParen = 9,
  EInvalidAst = 10, EFunctionSyntax = 11, EUnknownType = 12,
  EDuplicateFunction = 13, EDuplicateParameter = 14, EUndefinedName = 15,
  ETypeMismatch = 16, EReturnType = 17, ECapacity = 18
};
enum TypeKind : U32 { TypeU32 = 1, TypeStr = 2 };
enum ModuleLimit : U32 { MaxFunctions = 256, MaxParameters = 64 };
enum LexState : U32 {
  SBase = 0, SName = 1, SNumber = 2, SSlash = 3, SLine = 4,
  SBlock = 5, SBlockStar = 6, SString = 7, SEscape = 8, SCount = 9
};
enum ControlIndex : U32 {
  CTokenCount = 0, CNodeCount = 1, CRoot = 2, CErrorOffset = 3,
  CErrorCode = 4, CFunctionCount = 5, CCount = 6
};
struct Layout {
  U32 starts, ends, ranks, tokKind, tokBegin, tokEnd, delta, depth;
  U32 nodeFlags, nodeRanks, tokenNode, nodeToken, nodeKind, nodeDepth;
  U32 nodeValue, nodeBegin, nodeEnd, left, right, parent;
  U32 tree, errors, control, maps0, maps1;
  U32 fnFlags, fnRanks, closeInput, closeRanks, active, paramType;
  U32 nodeOwner, nodeBinding, nodeType;
  U32 fnToken, fnName, fnParamCount, fnReturnType, fnBodyBegin, fnBodyEnd, fnRoot, fnValid;
  U32 fnParams;
};
struct Params {
  Layout l;
  U32 n, size, step, a, b, c, d, chunk, mode;
};
