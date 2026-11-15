# Chez 以外の実装: Harlan と LIGO

## 1. 本当に Nanopass なのか。パーサはどこで動くか

### Takeaway
Harlan は Framework 直接採用の GPU 言語、LIGO は共通 AST＋検査器による独自 nanopasses。どちらも GPU パーサの先例ではない。

### Cited Findings
- **A: Framework 直接採用。** Harlan は Nanopass を git submodule に持ち、論文も Scheme 製 nanopass-style compiler と明記する。調査 pin は `3afd95b1c3ad02a354481774585e866857a687b8`（2015）。対象は研究用の OpenCL/C++ コンパイラであり Metal 実装ではない。— [.gitmodules](https://github.com/eholk/harlan/blob/3afd95b1c3ad02a354481774585e866857a687b8/.gitmodules), [著者論文 §5.1](https://theincredibleholk.org/papers/oopsla2014.pdf)
- **B: 自称 nanopasses の独自構成。** LIGO の `Nanopasses.passes` は `Ast_unified` 内の細粒度パスを並べ、最後に `Trivial.To_core` で `Ast_core` に移す。Scheme Framework の直接採用ではない。pin は `98081a730e3dc438790221c5190b11fb4ffc8f08`（2026-02-18、stable）。— [nanopasses.ml](https://github.com/ligolang/ligo/blob/98081a730e3dc438790221c5190b11fb4ffc8f08/src/passes/04-nanopasses/nanopasses.ml)
- Harlan の文字入力は `driver.scm:read-source` の Scheme `read`。`parse-harlan` は S 式を検査して変数・関数呼出し等をタグ付けする CPU の Scheme コードで、GPU カーネル生成より前に動く。Nanopass の `parse-M0` 等も**ソース文字列のパーサではなく中間 S 式→文法レコードの変換**。— [driver.scm](https://github.com/eholk/harlan/blob/3afd95b1c3ad02a354481774585e866857a687b8/harlan/driver.scm#L62), [front/parser.scm](https://github.com/eholk/harlan/blob/3afd95b1c3ad02a354481774585e866857a687b8/harlan/front/parser.scm), [compile-opts.scm](https://github.com/eholk/harlan/blob/3afd95b1c3ad02a354481774585e866857a687b8/harlan/compile-opts.scm)
- LIGO は構文固有の CST を持ち、CameLIGO の `03-unification/cameligo/compile.ml` は `I = Cst.Cameligo`、`O = Ast_unified` として明示的に変換する。その後の nanopasses も OCaml の再帰 AST traversal である。— [CST adapter](https://github.com/ligolang/ligo/blob/98081a730e3dc438790221c5190b11fb4ffc8f08/src/passes/03-unification/cameligo/compile.ml), [recursion_schemes.ml](https://github.com/ligolang/ligo/blob/98081a730e3dc438790221c5190b11fb4ffc8f08/src/stages/2-ast_unified/recursion_schemes.ml)

### Inferences
- GPU frontend に借りるのは**パーサ出力以降の契約・変換・検査の分離**。A/B は採用方式の分類で、品質順位ではない。

### Gaps
- Harlan/LIGO に GPU で字句解析・構文解析する実装は今回確認できなかった。複数 IR や LLVM/MLIR 利用だけを根拠に第三の「Nanopass 採用言語」を追加していない。

## 2. 各段階の契約・状態・合成・テストはどう実装されているか

### Takeaway
Harlan は文法差分で構文を消し、LIGO は同じ AST に残る禁止構文を reduction で検出する。いずれも文法の正しさと所有権・効果の正しさは別問題として読む必要がある。

### Cited Findings
- Harlan の `M0 → M1 → M2 → M3` は lambda を closure tag/group に変換し、最後に `make-closure`・`invoke`・closure 型を削除する。`define-language (extends ...)` の追加・削除で段階を定義する。`M5 → M6` は kernel 次元、`M6 → M7` は work size を明示する。— [M0-3.scm](https://github.com/eholk/harlan/blob/3afd95b1c3ad02a354481774585e866857a687b8/harlan/middle/languages/M0-3.scm), [M6.scm](https://github.com/eholk/harlan/blob/3afd95b1c3ad02a354481774585e866857a687b8/harlan/middle/languages/M6.scm)
- 全パスが Framework 製ではない。`compile-middle.scm` は `nanopasses` と通常の S 式変換＋`verify-*` を混用し、`compile-opts.scm` の `np-entry/np-exit` が連続 Nanopass 群の境界で parse/unparse する。通常 verifier は `verify` オプション依存で、常時検証とは言えない。— [compile-middle.scm](https://github.com/eholk/harlan/blob/3afd95b1c3ad02a354481774585e866857a687b8/harlan/middle/compile-middle.scm), [合成マクロ](https://github.com/eholk/harlan/blob/3afd95b1c3ad02a354481774585e866857a687b8/harlan/compile-opts.scm)
- Harlan の型・領域は同時に推論され、`uglify-vectors` が領域参照を offset と `region-ref` に落とし、必要な region を関数引数に追加する。`generate-kernel-calls : M8 → M9` は region の unmap、kernel 引数設定、OpenCL queue 実行を生成し、文法から `apply-kernel` を消す。— [uglify-vectors.scm](https://github.com/eholk/harlan/blob/3afd95b1c3ad02a354481774585e866857a687b8/harlan/middle/uglify-vectors.scm), [generate-kernel-calls.scm](https://github.com/eholk/harlan/blob/3afd95b1c3ad02a354481774585e866857a687b8/harlan/middle/generate-kernel-calls.scm)
- 入れ子 kernel は外側を残し、内側を `kernel->for` で逐次化する経路がある。論文は kernel 内 IO 禁止を述べる一方、違反を型で親切に診断する仕組みは将来の拡張としている。したがって「全ての入れ子並列を並列化」「確立した効果型・affine 所有権」の実証ではない。— [remove-nested-kernels.scm](https://github.com/eholk/harlan/blob/3afd95b1c3ad02a354481774585e866857a687b8/harlan/middle/remove-nested-kernels.scm), [著者論文 §3.1・5](https://theincredibleholk.org/papers/oopsla2014.pdf)
- LIGO の `for_to_while_loop.compile` は `Fold { idle_fold with instruction }` で変更部分だけを書く。`reduction` は残った `I_for_stmt` を拒否する。`compile_with_passes` は reduction を蓄積し、最終結果にまとめて適用するため、後続パスが禁止形を再導入した場合も検出対象となる。ただし各パス直後の検査ではない。— [for_to_while_loop.ml](https://github.com/ligolang/ligo/blob/98081a730e3dc438790221c5190b11fb4ffc8f08/src/passes/04-nanopasses/passes/for_to_while_loop.ml#L133), [pass_type.ml](https://github.com/ligolang/ligo/blob/98081a730e3dc438790221c5190b11fb4ffc8f08/src/passes/04-nanopasses/passes/pass_type.ml)
- LIGO は Fold/Check を合成して traversal を共有できるが、同じ群は子→親順。A が新しい子ノードを生成して B がその子を処理する場合、A/B を別群に置く必要があるとコード内で警告する。— [morphing.ml](https://github.com/ligolang/ligo/blob/98081a730e3dc438790221c5190b11fb4ffc8f08/src/passes/04-nanopasses/passes/morphing.ml#L163), [群の依存条件](https://github.com/ligolang/ligo/blob/98081a730e3dc438790221c5190b11fb4ffc8f08/src/passes/04-nanopasses/nanopasses.ml#L61)
- LIGO の名前が `linearity` のパスは pattern/type の**重複 binder・label 検査**で、値の一回使用検査ではない。本来の型検査は `Of_core.typecheck : Ast_core.program → Ast_typed.program` として後段に分離される。— [linearity.ml](https://github.com/ligolang/ligo/blob/98081a730e3dc438790221c5190b11fb4ffc8f08/src/passes/04-nanopasses/passes/linearity.ml), [of_core.ml](https://github.com/ligolang/ligo/blob/98081a730e3dc438790221c5190b11fb4ffc8f08/src/main/compile/of_core.ml)
- LIGO は各パス内に S 式の入力→出力、失敗、compile/decompile の expect test を置く。Harlan の runner は compile-fail/run-fail を扱う。— [LIGO test helpers](https://github.com/ligolang/ligo/blob/98081a730e3dc438790221c5190b11fb4ffc8f08/src/passes/04-nanopasses/passes/unit_test_helpers.ml), [Harlan runner](https://github.com/eholk/harlan/blob/3afd95b1c3ad02a354481774585e866857a687b8/run-tests.scm)

### Inferences
- 「opcode が消えた」という文法契約と、region 生存・効果・書込競合の解析を分ける。文法だけで意味保存や所有権は証明されない。

### Gaps
- Harlan の GPU OOM 回復は論文では将来項目。一方 pin の `remove-transactions` は snapshot/reserve/reset を生成するが、今回 replay の完全性は検証していない。自動再実行の完成例として推奨しない。— [remove-transactions.scm](https://github.com/eholk/harlan/blob/3afd95b1c3ad02a354481774585e866857a687b8/harlan/middle/remove-transactions.scm)

## 3. Metal 向け flat SoA IR に何を借り、何を避けるか

### Takeaway
段階契約は Harlan、検査・デバッグは LIGO を参照する。木の表現を GPU に移す根拠はない。

### Cited Findings
- Harlan の言語ファイルは多数の中間文法を分割し、その理由としてコンパイラ自身のコンパイル時間を挙げている。LIGO は CLI に `--nanopass NAME/NAME+` を持ち、パスの直前・直後を観察できる。— [Harlan languages README](https://github.com/eholk/harlan/blob/3afd95b1c3ad02a354481774585e866857a687b8/harlan/middle/languages/README.md), [LIGO CLI](https://ligolang.org/docs/next/manpages/print%20ast-unified/)

### Inferences
- **提案:** SoA の物理列を共有しても、`Parsed/Resolved/Typed/Affine/KernelReady` 等の段階 handle と生成 builder/verifier を別契約にする。巨大 union を保つなら禁止形 validator を置く。stage handle と参照整合性・affine 使用回数の検査は別。
- **提案:** kernel 次元確定、work size 確定、free variable/region 引数化、配置・address space 確定、launch 生成を独立させる。Harlan の外側並列保持は初期戦略の候補であり、Metal で最適という主張ではない。
- **提案:** GPU frontend には各パスの read/write 列、生成ノード数、prefix-sum/compaction の要否も契約に足す。LIGO の融合条件を参考に、依存を満たすパスだけを融合し、単独パスと融合パスの結果を比較する。
- **読む順序:** Harlan は上記 `driver/read-source → front/parser → front/typecheck → languages/M0-3 → compile-middle → make-kernel-dimensions-explicit → uglify-vectors → generate-kernel-calls`。LIGO は `CST → 03-unification → Ast_unified/types/recursion_schemes → for_to_while_loop → pass_type/morphing → nanopasses → Of_core`。一構文の消去を先に追う。

### Gaps
- 固定 commit のソース調査であり、ビルド・テスト・Metal 移植・GPU parser 試作は未実施。OpenCL の性能やメモリ方式を Apple に外挿しない。GPU parsing 手法は別調査を要する。
