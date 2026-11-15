# Metalic

UTF-8 ソースからトークン列と flat AST を **Metal GPU 上で構築する**、macOS 専用の小さなフロントエンド。関数モジュールでは引数の名前解決と `u32`／`str` の型検査も GPU で行う。Node.js は入力と最終結果の表示、Objective-C++ はバッファ確保とコマンド発行を担当する。GPU 経路は CPU パーサを呼ばない。Bend を参考にした独立の実験言語であり、Bend ソースをコンパイルするものではない。

Bend 内で作成した試作とリサーチを `mizchi/metalic` に切り出した。Bend の checkout や runtime はビルド・実行に不要。

```sh
git clone https://github.com/mizchi/metalic.git
cd metalic
pnpm install --frozen-lockfile
just test
pnpm parse --summary examples/arithmetic.np
pnpm parse --module --summary examples/functions.np
just parse examples/arithmetic.np
just module examples/functions.np
just validate
just bench
just bench-diagnostics
```

必要環境は Apple Silicon の Metal GPU、macOS 26以降、対応 Xcode／Metal Toolchain、Node.js 24+、pnpm、just。MSL 4.0 を明示指定し、Apple M5 / macOS 26.6.2 で動作確認した。実行時依存の npm ライブラリはなく、TypeScript と Node の型定義は検査用の開発依存。

**MSL 4.1 の採用と OS／Xcode の更新は後回しにし、当面は4.0で検証する。** 最新 MSL を使う将来の [v2 設計案](<reports/Metal GPU 言語処理系 の 設計最適化.md>)と、現在の [診断集約の比較検証](reports/診断集約の比較検証.md)を分けて記録する。4.1固有の機能が必要になる検証は、その時点で要件を確認する。

## 実装とリサーチ

| 場所 | 内容 |
|---|---|
| [`native/`](native/) | Metal kernels、Objective-C++ の host、共通 ABI |
| [`src/`](src/) | 公開 API、CLI、独立した CPU 参照実装 |
| [`tests/`](tests/) | CPU/GPU の差分テスト |
| [`examples/`](examples/) | 式・関数モジュールのサンプル |
| [`measurements/`](measurements/) | 実装の hash と保存済み計測値 |
| [`reports/`](reports/) | 調査を統合した設計レポート |
| [`research_notes/`](research_notes/) | 出典、調査ノート、小実験・計測記録 |

レポートは以下の順に読める。最新の採用方針は v2 設計案に置く。

1. [Metal 向け コンパイラ と 実行基盤](<reports/Metal 向け コンパイラ と 実行基盤.md>) — Bend／Mojo、Metal の制約と同期、関連研究。
2. [Metal 言語処理系 の ナノパス設計](<reports/Metal 言語処理系 の ナノパス設計.md>) — Chez／Harlan 等を参考にした段階契約。
3. [Metal GPU 言語処理系 の 設計最適化](<reports/Metal GPU 言語処理系 の 設計最適化.md>) — 2024–2026年の研究、現行の費用、MSL 4.1 を基準にした v2。
4. [診断集約の比較検証](reports/診断集約の比較検証.md) — MSL 4.0で3方式を実装・照合し、発行回数と処理時間を比較。

`pnpm parse --cpu file.np` は独立した CPU oracle を明示的に使う。`--module --cpu` では関数モジュールの oracle を使う。GPU が使えない場合はエラーにし、暗黙の CPU fallback はしない。`--chunk-size 7` などで字句チャンクを変更できる。

診断集約は `--diagnostics packed`（既定）、`hierarchical`、`tree` で切り替える。TS API では第4引数に `{diagnostics: 'tree'}` 等を渡せる。結果の `mslVersion` は shader が報告した言語バージョン、`diagnosticDispatches` は診断専用 dispatch の件数を表す。

## 現在の言語範囲

```ebnf
program = expr, { ";", expr }, [ ";" ];
expr    = product, { ("+" | "-"), product };
product = prefix, { ("*" | "/"), prefix };
prefix  = { "+" | "-" }, atom;
atom    = uint32 | identifier | string | "(", expr, ")";
```

整数は十進 u32、識別子は ASCII の英字・数字・アンダースコア。文字列内は UTF-8 と escaped byte を保持し、内容の評価は行わない。文字列内の非 escape 改行は拒否する。`//` コメントは CR/LF で終了し、`/* */` は入れ子にしない。空の式プログラムは `EExpectedOperand`。位置は常に UTF-8 **byte offset**。

二項演算は左結合、prefix 演算は右結合。式モードでは `;` は `NSequence` にし、名前解決・型検査をせずに構文として AST に残す。

`--module` は次の宣言文法を明示的に選ぶ。

```ebnf
module    = function, { function };
function  = "fn", identifier, "(", [ parameter, { ",", parameter } ], ")",
            ":", type, "{", expr, [ ";" ], "}";
parameter = identifier, ":", type;
type      = "u32" | "str";
```

```text
fn add(x: u32, y: u32): u32 { x + y }
fn identity(text: str): str { text }
```

各関数は独立した引数スコープを持つ。関数名の重複、同一関数内の引数名の重複、未定義名、数値演算への `str` の入力、戻り値の型の不一致を拒否する。演算子の出力は `u32` と決まっているため、この型系の検査は型の初期化と各ノードの局所検査で完了する。一般の型推論や依存型検査の並列化を実現したものではない。`fn` はモジュールモードのみの予約語。上限は256関数、各64引数で、超過は GPU の診断になる。

関数呼び出し、ローカル `let`、分岐、型推論、affine 使用検査、ユーザープログラムの評価・コード生成は未実装。

## パスとコントラクト

| パス | 入力から出力 | 主な保証 |
|---|---|---|
| Lex | Source → LexemeFlags | チャンクの入口状態、開始・終了 flag、字句エラー |
| Tokenize | LexemeFlags → TokenIR | prefix scan と scatter による kind/begin/end の密な列 |
| Structure | TokenIR → StructuredTokens | 括弧深度、token 隣接規則、文法エラー |
| NormalizeOperators | StructuredTokens → OperatorIR | prefix/binary の区別、優先順位、ノードの密な列 |
| BuildAst | OperatorIR → RawAst | parent/left/right の Cartesian tree |
| ValidateAst | RawAst → CheckedAst | arity と親子関係、最初の診断 |
| ResolveNames（module） | CheckedAst → ResolvedAst | 宣言の一意性、引数への binding ID |
| CheckTypes（module） | ResolvedAst → TypedAst | primitive 型、演算の入力型、戻り値型 |

[`native/contract.h`](native/contract.h) が ABI と enum の正本。`scripts/generate.mjs` は TypeScript の enum 定数を生成する。[`src/contract.ts`](src/contract.ts) が公開結果型で、`native/passes.h` の移動専用パストークンが予約順と入力の再使用を検査する。予約済みの状態と GPU 完了は区別し、結果は完了後にだけ読む。これは Nanopass の段階契約を参考にした手書きの構成で、Scheme Nanopass Framework を GPU 上で動かしたものではない。

中間データは単一の shared buffer 内の SoA 列に保持する。トークン・ノードの **容量**をソース byte 数で抑え、**論理件数**は GPU control buffer に置く。各 dispatch は容量を上界とし、GPU が件数で guard する。中間件数の CPU readback、トークンごとの CPU callback はない。各入力につき一つの command buffer と最後の明示的 completion wait 一回で処理する。通常の Metal command buffer の資源保持とホスト側の所有オブジェクトを、完了まで維持する。

最終結果を JSON に dump するため CPU が列を読む。外部 API へ長寿命の GPU バッファ handle を返す機能は未実装。入力上限は一つにつき 1 MiB。すべてを shared にしてあり、storage mode の最適化や Metal 4 専用 API はまだ比較していない。

## GPU アルゴリズム

字句解析は9状態の DFA。各チャンクが **すべての入口状態に対する遷移関数**を作り、関数合成の prefix scan で実際の入口状態を求める。その後に token 開始・終了 flag を出す。状態関数をベクトルで保持するため、遷移モノイドの ID と巨大な合成表を生成する必要はない。チャンク間の prefix は Hillis–Steele、整数列は256スレッドの局所 scan＋再帰的 group scan を使う。

構文解析は今回の固定式文法に特化する。token の隣接規則と括弧深度が文法を検査し、`(depth, precedence, associativity/index)` の全順序から Cartesian tree を構築する。range-minimum segment tree を作り、各ノードが nearest-smaller neighbor を O(log capacity) で探す。各ノードを一つの GPU スレッドが処理し、一つのスレッドで全体を逐次 parse する実装ではない。

関数モジュールでは `fn` の位置を scan/scatter し、逆向きの minimum scan で次の閉じ波括弧を索引する。宣言ヘッダは各関数に一つの GPU スレッドを割り当て、最大64引数を逐次処理する。本体の字句・構文解析はノードごとに並列のまま。Cartesian tree の探索範囲を関数本体に限定し、関数ごとの root を作る。名前解決は各参照が自分の引数表を探索する。関数名の重複確認は先行する最大255宣言、引数名の重複確認は最大63引数との比較で、ハッシュ表はまだ導入していない。

一般文法を扱う LLP parser generator は未実装。この固定文法で成立する検査を、任意の LL/LR 文法やブロック構文へそのまま広げてはいけない。Pareas の DFA/scan と構造の合成を参照している。

AST の NodeId は本体の括弧等を除いた token 順。node span はそのノードを定義する **token の範囲**であり、部分木全体の範囲ではない。親子列は NodeId、未接続は `null`。文字列や識別子は token span から元ソースを参照する。モジュールの各ノードは宣言順の `functionId`、引数名の TokenId を使う `binding`（非参照は `null`）、`type` を持つ。`functions` には関数名の span、引数列、戻り値型、本体の NodeId を返す。モジュール全体の `root` は `null`。

エラー時は AST・関数表を公開せず、`nodes: []`、`functions: []`（module）、`root: null` を返す。診断は構文・名前・型の順に検査し、エラーのある段階で最小 byte offset、同位置では error code 順の一件を返す。同じ EOF への並行診断には atomic 操作を使う。複数エラーの回復処理は含まない。

## 検証と計測

`just test` は ABI 生成・ビルド、TypeScript strict 検査、20本のテストを実行する。優先順位・左結合・右結合 prefix、2048個の prefix、深い括弧、長い識別子、文字列・コメント、64通りの alignment、4種類の chunk size、固定 seed の生成式、不正入力の挿入、80,001ノードでの3階層 group scan を照合する。モジュールは独立スコープ、型エラー、204通りの宣言破壊、関数・引数の上限、深さの異なる128関数の式木を確認する。CPU oracle は逐次 byte lexer＋反復 shunting-yard と逐次の宣言・型検査で、GPU の遷移関数 scan／Cartesian tree を再利用していない。

`just validate` は Metal API/GPU validation を有効にして式4件・モジュール12件を3方式で実行し、計48件の正常系・深い木・複数 threadgroup・異常系を確認する。通常の速度測定とは別に実行する。

`just bench` は3回の warmup 後20回を測り、`build/benchmark.json` に保存する。GPU frontend 時間は確保・初期化・encode/submit・最後の wait を含み、最終 JSON 化は含まない。device interval、library/pipeline setup、プロセス起動・23回の実行と最終 AST の転送を含む batch wall time も分ける。OS の Metal cache は無効化していない。CPU は TypeScript の正しさ確認用 oracle であり、最適化された CPU parser との速度比較ではない。p95 も20標本の参考値。自動 CPU/GPU 選択はまだ実装しない。

初回の tree 方式の計測 snapshot とソース SHA-256 は [`measurements/apple-m5.json`](measurements/apple-m5.json) に保存している。診断の改善を比較する `just bench-diagnostics` は、各ケースにつき同一プロセスで3方式の順序を回転し、3 warmup＋30標本＋表示用の最終1回を実行して `build/diagnostics-benchmark.json` に保存する。[試行1](measurements/apple-m5-diagnostics-trial1.json)・[試行2](measurements/apple-m5-diagnostics-trial2.json)は別の保存記録。現段階では容量上界への dispatch と毎回の確保・初期化が残り、次は arena 再利用、count を使う indirect dispatch、同じ契約の native CPU baseline を比較する。

Apple M5 での初回 tree 方式のモジュール計測（各関数に32項の式、中央値。現在の比較は上記の試行1・2を参照）：

| 関数数 | 入力 bytes | AST ノード数 | GPU frontend | GPU device interval |
|---|---:|---:|---:|---:|
| 1 | 301 | 191 | 1.21 ms | 0.86 ms |
| 32 | 9,685 | 6,112 | 1.23 ms | 0.86 ms |
| 256 | 77,713 | 48,896 | 1.78 ms | 0.62 ms |

これは8パスを通して名前解決・型検査まで済ませた時間。小さな入力でも確保・コマンド発行・同期の固定費が目立つ。device interval は OS のスケジューリング等でも変動するため、この標本で入力サイズに対する単調な増加や最適な CPU/GPU 切り替え境界は判断しない。完了 wait 単独の費用や最終 JSON 読み出しの費用も、この表では分離していない。

## 参照

- [Chez の段階文法](https://github.com/cisco/ChezScheme/blob/d533f2e156d4eddeafe24bd7cc4de87fdc88caeb/s/np-languages.ss)：パスの入出力契約。
- [Harlan の GPU lowering](https://github.com/eholk/harlan/blob/3afd95b1c3ad02a354481774585e866857a687b8/harlan/middle/compile-middle.scm)：GPU 向けの段階化。
- [Pareas](https://github.com/Snektron/pareas) と [論文](https://theses.liacs.nl/pdf/2020-2021-VoetterRobin.pdf)：GPU frontend の DFA 遷移合成と構造処理。
- [Bend](https://github.com/bendlang/bend)：所有する値と明示的 task/continuation の設計。Bend 本体や gates は変更していない。
