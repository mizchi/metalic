# GPU parser と Metal 実行をつなぐ Nanopass 設計

## 1. byte 入力から GPU 常駐 AST をどう作るか

### Takeaway
パーサを最初から GPU 対象にする。CPU は correctness oracle と性能比較実装であり、CPU frontend を必須とする構成ではない。

### Cited Findings
- Pareas は独自の手続き型言語を GPU で字句・構文・意味解析する。DFA 遷移関数の合成を scan し、LLP(1,1) の局所解析結果を結合する。JSON 専用器とは別に compiler と parser generator がある。— [論文 §3–4][P]、[実装][PG]
- Pareas は depth scan と typed bracket matching を使い、左再帰を除いた parse tree を後段で左結合へ再構成する。— [§4.5・4.8.1][P]
- Bend parser は位置・indent・scope stack・宣言表を参照する。constructor の判定も宣言依存である。— [Parse 型][BT]、[parser][BP]

### Inferences
以下は上記を Metal に適用する**提案**で、実装済みという主張ではない。

1. **文法を検査する。** 明示的 `()`/`{}`/`;`、固定優先順位、明示された関数・型構文を初期候補にする。indent と宣言依存の構文判定は避ける。LLP 生成表の衝突は文法変更または方式再選定の理由とし、任意の LL/LR 文法へ適用可能とはしない。
2. **chunk 間の字句状態をつなぐ。** 最長一致/emit 規則を含む DFA/transducer を定義する。chunk ごとの開始状態→終了状態の要約 F を合成 scan し、入口状態を得て局所走査する。文字列 escape、コメント、長い識別子を境界で分断しても token と元 byte span を変えない。Pareas の遷移関数 ID＋合成表は候補だが、t 個の ID に対する t² 表と生成費用を無視しない。
3. **GPU token 列を作る。** 境界 flag→scan→scatter/compact で kind/begin/end を構築する。有効件数 n は GPU control buffer に置き、毎段 host に返さない。
4. **構文全体を検査する。** LLP 候補では局所 lookback/lookahead→stack-change/production 列→offset scan→連結→typed bracket 整合性→flat tree と進む。括弧照合だけでは文法の受理判定にならない。右再帰化を使うなら優先順位・左結合の復元と補助 node 除去を別契約にする。
5. **scope を構築する。** block/lambda の親子から ScopeId を作り、宣言と参照を分けて可視範囲・shadowing を解決する。型推論の依存鎖まで独立 map になったとはしない。

以上の根拠は [Pareas の各アルゴリズム][P]。chunk/global scan、matching/sort、compact が kernel 境界候補になる。深さ N の括弧列でも depth が分かれば処理終了ではなく、matching・親構築・木変換の work/メモリを要する。広い木、深い鎖、長い演算子列を別評価する。要素局所処理は融合し、global 依存は dispatch 境界に残す。— [Pareas §4–6][P]、[既存 Metal 調査][R]

診断は `SourceId＋revision＋UTF-8 byte [begin,end)` と origin を全段維持する。最小版は AST＋元 token/source 対応、IDE 用 lossless CST は別選択でよい。不正宣言を隔離し delimiter/次宣言へ進む回復を提案する。必ず token が進み、壊れた単位は codegen に渡らない。GPU が diagnostic record、CPU が安定順の表示を担当する。— span の動機: [Bend][BP]。**この回復を Pareas が実装済みという意味ではない。**

### Gaps
文法、Unicode 識別子、入れ子コメント、回復範囲は未決定。LLP 以外の方式は未評価。有限状態 lexer に無制限の入れ子を含めない。

## 2. Nanopass と実行 runtime の契約をどう切るか

### Takeaway
GPU compiler と生成プログラムの GPU 実行は別軸。意味パスと kernel も一対一にしない。

### Cited Findings
- Nanopass は中間文法と pass の入出力言語を定義する。`define-parser` の例は S 式→IR record であり、一般テキスト parser の並列化機能ではない。— [公式ガイド][N]
- Chez は closure conversion とメモリ表現の展開を分離する。Harlan は Nanopass で kernel 次元/work size、自由変数、vector、launch 等を段階化するが、frontend は CPU の Scheme reader/parser である。— [Chez][C]、[Harlan pipeline][H]、[reader][HR]
- 現行 Bend は host compiler と owned task/continuation の CPU/device 共通 flat evaluator を持つ。旧 interaction-net engine ではない。— [compiler][BC]、[BendRT][BR]

### Inferences
GPU frontend を採っても、MSL source 生成、Apple toolchain 呼出、PSO 作成、host plan 実行は CPU に置ける設計とする。byte 解析の CPU 代行とは区別する。

初期十パスの**提案コントラクト**。各出力に validator を置く。— 分割の根拠: [Nanopass][N]、[Chez][C]、[BendRT][BR]

| パス | 入力 → 出力 | 出力の不変条件 |
|---|---|---|
| Lex | source → tokens | 元範囲/EOF/不正字句が明示され、chunk 分割に非依存 |
| Parse | tokens → surface tree | 文法全体を受理/拒否。parent/child/origin が整合。不正単位を隔離 |
| NormalizeSyntax | surface → Core | 糖衣・parser 補助 node が消え、優先順位・結合・評価順が確定 |
| Resolve | Core → Resolved | 全参照が可視な BinderId/GlobalId を持ち、未解決名がない |
| CheckTypes | Resolved → Typed | 全式/関数境界の型、arity、分岐が整合。hole を後段へ流さない |
| CheckUses | Typed → Affine | 経路ごとに所有値を高々一回消費。分岐を単純合算せず move/borrow/drop/alias を確定 |
| CloseFunctions | Affine → Closed | 自由変数を順序付き env へ。code＋env と捕捉の所有権/寿命が明示 |
| ClassifyDevice | Closed → Classified | 到達呼出先と effect/capability の要約が確定。適格/host の理由を持つ |
| LowerExecution | Classified → 実行 IR | 評価順と引数値が明示され、下記 backend 契約を満たす |
| Emit | 実行 IR → CPU/MSL＋host plan | ABI、layout/count/capacity、dispatch、依存、completion が一致 |

**直接 MSL** は map 等を kernel 化し、index/shape と対応演算を検査する。**evaluator** は Bend を参考に segment id、value frame、tail/cut/fork、continuation、join slot を明示し、queue/stack/heap 容量と公開・可視化を契約化する。最初は片方を選ぶ。— [BendRT][BR]、[既存調査][R]

pure でも外部 handle、未対応演算・確保・間接呼出は device 不適格になり得る。捕捉と call graph 固定点も検査する。Bend の `f!` はユーザー CPU/GPU 計算を交替させる境界であり、任意 future や最適配置の証拠にしない。— [BendRT][BR]

常駐 IR は typed immutable SoA snapshot、`NodeId<generation>`、node/scope 軸、可変長辺の offset/data を持つ提案とする。容量 C と GPU 件数 n を分離し、read/write region の権利は最終 completion まで保持する。Bend の corpus/固定 scheduler を一括採用しない。— [既存提案][R]、[Metal 同期][A]

### Gaps
実装言語、構文、overflow、評価順、型推論、再帰、effect、borrow は未決定。Bend の依存型は前提にしない。

## 3. GPU-first の最小到達点と TDD をどう定めるか

### Takeaway
第一成果は byte 入力→GPU 常駐 AST の parser。後段の言語範囲は配列 kernel と owned task の二候補から選び、GPU frontend を後回しにしない。

### Cited Findings
- Pareas は小入力の同期、全木の反復走査、一時メモリ、CPU baseline の限定を挙げる。— [§5–6][P]
- Harlan は内側の nested kernel を逐次 loop にする段階も持つ。Nanopass 採用を全並列性の自動抽出と読まない。— [lowering][HN]

### Inferences
**M0: GPU parser。** 関数定義、型注釈、let/block/if/call、括弧、複数優先順位を持つ小言語で、GPU lex→文法検査→AST までを完成させる。host の生成表作成・ファイル入力・診断表示と、CPU に構文解析を代行させることを区別する。— 範囲の根拠: [Pareas][P]

探索→fixture 固定→Red→最小 Green→refactoring で次を検査する。

- 全 byte 位置で chunk 境界をずらし、識別子/escape/comment/operator の token・AST・span が不変。
- `a-b-c`、`a+b*c`、括弧、unary minus、入れ子 if/call の木が CPU oracle と一致。不正括弧・token 順序・宣言は拒否。
- 空入力、深い nest、長い演算列、多数の短い定義、複数エラーで count/capacity、元 span、回復の進捗を保証。
- grammar/表生成の cold 費用、library/PSO 初期化、warm parse を分離。cold CLI/warm batch/小編集で準備・submit・同期・診断消費込みの時間と peak bytes を比較。

**M1-I: 配列中心。** u32/bool、型付き関数、scalar capture、読取配列/所有出力、map 連鎖を直接 MSL へ。GPU frontend→束縛/型/使用検査→CPU/Metal の同値を完成条件とする。空/端数長、shadowing、捕捉、二重 move、host effect の拒否、融合前後を検査する。

**M1-II: owned task 中心。** 小 ADT、match、有限タグ closure、構造再帰、fork/join を evaluator へ。均衡木/偏った木の値、join の一回性、容量超過時の無破壊失敗、completion 前の owner 再利用禁止を検査する。

M1 の選択が後段/runtime を変える。CPU/GPU 配置の最良解が入力サイズだけで静的に決まるとは仮定しない。Chez の差分文法/closure 契約、Harlan の GPU lowering、Bend の owned task、Pareas の GPU frontend を役割別に借り、同じ record/メモリ表現と見なさない。— [Chez][C]、[Harlan][H]、[BendRT][BR]、[Pareas][P]

### Gaps
性能・kernel 数は未計測。2026-11-15 の設計調査で、実装/benchmark/インストールは未実施。Bend ソースと既存 PR_BODY.md は未変更。

[P]: https://theses.liacs.nl/pdf/2020-2021-VoetterRobin.pdf
[PG]: https://github.com/Snektron/pareas
[N]: https://docs.racket-lang.org/nanopass/index.html
[BT]: https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/bend.ts#L338
[BP]: https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/bend.ts#L1540
[BC]: https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/comp.ts#L2784
[BR]: https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/BendRT/main.typ
[C]: https://github.com/cisco/ChezScheme/blob/d533f2e156d4eddeafe24bd7cc4de87fdc88caeb/s/cpnanopass.ss#L1418
[H]: https://github.com/eholk/harlan/blob/3afd95b1c3ad02a354481774585e866857a687b8/harlan/middle/compile-middle.scm
[HR]: https://github.com/eholk/harlan/blob/3afd95b1c3ad02a354481774585e866857a687b8/harlan/driver.scm#L62
[HN]: https://github.com/eholk/harlan/blob/3afd95b1c3ad02a354481774585e866857a687b8/harlan/middle/remove-nested-kernels.scm
[A]: https://developer.apple.com/documentation/metal/synchronizing-cpu-and-gpu-work
[R]: <../../reports/Metal 向け コンパイラ と 実行基盤.md>
