# GPU 向けパーサと構文 IR の設計

調査基準日: 2026-11-15。以下は既存試作を GPU 向けに設計し直すための調査メモであり、新方式の実装・性能検証は行っていない。

## 1. Pareas 以後の研究から何を採るか

### Takeaway

新しい直接候補は **Alpacc / ARRAY 2024 の LLP 生成器**、**2025年の cyclic operator precedence grammar とその並列パーサ**、**cuJSON / ASPLOS 2026 の構造配列設計**。JSON パーサの成功を汎用言語の文法・意味解析の実証に広げず、それぞれの担当範囲を限定して借りる。

### Cited Findings

| 一次資料・時期 | 確認した内容 | 試作への用途と制限 |
|---|---|---|
| Robin F. Voetter, Marcel Huijben, Kristian F. D. Rietveld, **Compilation on the GPU? A Feasibility Study**, Computing Frontiers 2022（2022-05-05公開） | 独自の小さな手続き言語を GPU 上で字句解析から RISC-V 生成まで処理。Futhark の本体と C++ の生成器・driver を分離。Pareas は compiler、JSON parser、lexer/parser generator を別に持つ。 | 引き続き全体構成の基準。新しい言語を設計した研究であり、任意の既存言語を自動並列化する根拠ではない。— [DOI](https://doi.org/10.1145/3528416.3530249)、[著者コードと論文情報](https://github.com/Snektron/pareas) |
| Lilje Henrich Due, Troels Henriksen, **An LLP(q,k) Parser Generator**, ARRAY 2024、2024-06-25発表 | データ並列向け LLP(q,k) parser generator を実装し、JSON parser で評価。現行 **Alpacc** は Futhark を生成し、UTF-8 `u8` 入力から production/terminal の preorder 配列、parent index、terminal の入力 span を返す。 | 手書きの固定演算子パーサから、生成表を使う文法契約への発展候補。LLP は LL 全体・CFG 全体ではない。2023年の学位論文の「木生成未実装」を、現在の実装にそのまま当てはめない。— [会議公式](https://pldi24.sigplan.org/details/ARRAY-2024-papers/2/An-LLP-q-k-Parser-Generator)、[現行著者実装](https://github.com/diku-dk/alpacc) |
| Michele Chiari, Dino Mandrioli, Matteo Pradella, **Cyclic operator precedence grammars for parallel parsing**, *Information and Computation* 307、105363、2025年11月号。前身は DLT 2024、arXiv 初版2023-09-08 | 通常の OPG の equal-precedence 非循環制約を外し、生成規則の右辺に限定された正規表現を許す。unranked tree と平坦な無限長の部分構造を扱う。2025年版は DLT 2024 の説明・証明を拡張。 | 引数列・宣言列・文列を初めから可変長の子配列にする根拠。理論論文自体は GPU 上の高速な compiler 実装の実証ではない。— [出版社全文](https://www.sciencedirect.com/science/article/pii/S0890540125000999)、[著者PDF](https://pradella.faculty.polimi.it/papers/cyclop-ic.pdf)、[初版履歴](https://arxiv.org/abs/2309.04200) |
| Michele Chiari, Michele Giornetta, Dino Mandrioli, Matteo Pradella, **Boosting Parallel Parsing through Cyclic Operator Precedence Grammars**, SLE 2025、2025-06-12–13、pp.44–56 | C-OPG を使う生成器・パーサを GoPAPAGENO に実装し、従来 OPP/AOPP と比較。局所解析可能性と平坦な構造を組み合わせる。主な実験対象は JSON 系のデータ。 | C-OPG の実装可能性を確認する資料。**Go / goroutine の CPU 並列実験であり、Metal/GPU の実測ではない**。論文自体がより複雑な構造と semantic analysis への拡張を今後の課題にしている。— [全文PDF](https://repositum.tuwien.at/bitstream/20.500.12708/217251/2/Chiari%20Michele%20-%202025%20-%20Boosting%20Parallel%20Parsing%20through%20Cyclic%20Operator...pdf)、[日付・DOIの大学記録](https://repositum.tuwien.at/handle/20.500.12708/217251?mode=full)、[DOI](https://doi.org/10.1145/3732771.3742712) |
| Sacheendra Talluri ほか, **GpJSON: High-performance JSON Data Processing on GPUs**, PVLDB 18(9)、2025、3216–3229 | 構造索引を GPU 上で作り、LD-JSON に対する JSONPath query を GPU 内で処理。索引間で CPU のオブジェクト木を作らず、構造ビットマップを後段も利用する。CUDA / A100 の評価。 | フロントエンドの出力を後段の計算に合わせて保持する例。深さ別 bitmap を一般の深い AST に無条件で採用する根拠にはしない。JSON query と汎用 parser は別。— [全文PDF](https://vldb.org/pvldb/vol18/p3216-bonetta.pdf)、[著者コード](https://github.com/gpjson-vldb/gpjson) |
| Ashkan Vedadi Gargary, Soroosh Safari Loaliyan, Zhijia Zhao, **cuJSON: A Highly Parallel JSON Parser for GPUs**, ASPLOS 2026 Vol.1、85–100、DOI 10.1145/3760250.3762222 | 著者実装は UTF validation、tokenization、nesting recognition を GPU に置く。結果は元入力・構造文字位置 `structural`・対応する閉じ位置 `pair_pos` などの配列。CUDA の公開実装と再現用 scripts がある。 | 同じ入れ子構造でも pointer tree を出力する必要がない例。**JSON 専用**であり、compiler の演算子・scope・型推論を解決するものではない。README の引用年は2025、著者の業績表と会議は ASPLOS26 としているため「2025公開／ASPLOS26」と区別する。— [著者実装全文](https://github.com/AutomataLab/cuJSON)、[著者業績表](https://www.cs.ucr.edu/~zhijia/html/publications.html)、[会議プログラム](https://asplos-conference.org/asplos2026/program/index.html)、[DOI](https://doi.org/10.1145/3760250.3762222) |
| Thomas Smith, Raph Levien, John D. Owens, **Decoupled Fallback: A Portable Single-Pass GPU Scan**, SPAA 2025、2025-07-16公開／7月28日–8月1日会議 | forward progress に依存する lookback を、待ち過ぎた tile の再計算で補う。M1 Max と M3 を **WebGPU / Dawn** で実測。scan は非可換モノイドも理論上扱い、状態・値を分割した atomic 表現を提案する。 | parser の scan 基盤の直接候補。論文の大きな prefix-sum 入力での結果を、小さい9状態 DFA 合成や M5 native Metal の性能と同一視しない。— [全文PDF §2,4,5](https://escholarship.org/content/qt0bk9z4bt/qt0bk9z4bt.pdf)、[著者 artifact](https://github.com/b0nes164/Decoupled-Fallback-Paper) |

### Inferences

- 上記を一つの巨大な「最新方式」に混ぜない。**LLP/C-OPG は文法と解析の分割**、**cuJSON/GpJSON はデータ表現と後段の利用**、**Decoupled Fallback は scan の物理実装**という別の層として選ぶ。
- 初手は Alpacc が受理できる v2 文法を生成器で確認し、同じ文法から参照パーサ・GPU の表・IR validator を作る。LLP(1,1) に収まらない場合は、q/k を増やした表の大きさ・生成時間と、文法変更／C-OPG の別案を比較する。q/k を増やせば常に実用的になるとは想定しない。
- 現在の「chunk ごとの全9入口状態を要約し、その合成を scan」は維持する合理性がある。新しい single-pass scan が必要かは、scalar sum/min、非可換の状態遷移合成を別々に比較する。scalar で速くても9状態の合成で速い保証はない。

### Gaps

- cuJSON の ACM 論文本文は取得制限で未読。GPU の担当段階・配列 API は公開実装全文から確認した。論文の倍率、非公開の細かな nesting algorithm、曖昧な日付は主張していない。
- ARRAY24 Alpacc の extended abstract は会議サイトの download action が必要で本文未取得。会議公式概要と現行コード README の具体的な入力・出力契約を確認した。性能数値は引用しない。
- **Nano-parsing: A Data-parallel Architecture for Perverse Parsing Environments**（Aaron Hsu / Brandon Wilson, ARRAY 2024, 2024-06-25）は公式概要を確認。APL の context-sensitive な offline parsing を対象とするが、extended abstract 本文・実測は未取得のため、主要な置換案の根拠にはしない。Nanopass framework と同じものとも扱わない。— [会議公式](https://pldi24.sigplan.org/details/ARRAY-2024-papers/9/Nano-parsing-A-Data-parallel-Architecture-for-Perverse-Parsing-Environments)
- 一般の compiler frontend を Metal 上で構築する2026年の新論文は、今回の検索範囲では確認できなかった。2026年の OCR / LLM constrained decoding の「parser」研究は目的が違うため採用していない。「不存在」を証明したものではない。

## 2. v2 の文法と構造表現を GPU にどう合わせるか

### Takeaway

文法を設計できるなら、**明示した境界・文脈に依存しない字句・平坦な列**を採用する。次の実装段階では、式をさらに並列化する前に「本当に対応する括弧」と「関数・block・list の構造索引」を独立した IR にする。

### Cited Findings

- 現在の試作は関数の閉じ位置を「次の `}`」の逆向き min scan で求める。関数本体に block の入れ子はなく、`fn` を境界候補として扱う。したがって、この索引を nested `if` / block にそのまま転用できない。— [現行 module.metal](../../../../native/module.metal)
- 現在の式 AST は `(depth,precedence,index)` の Cartesian tree を各ノードから RMQ 探索して作る。深い左結合木でも parse 自体を一つの逐次 stack で構築しているわけではない。C-OPG の「左に偏った木が parser を逐次化する」という動機を、そのまま現在のアルゴリズムの欠陥とはしない。— [現行 frontend.metal](../../../../native/frontend.metal)、[C-OPG 論文](https://pradella.faculty.polimi.it/papers/cyclop-ic.pdf)
- Pareas の元研究は bracket matching、tree construction、previous-smaller などを別々のデータ並列問題として扱う。既存の finite-state lexer は有限な entry state の合成を使う。— [2021年著者学位論文](https://theses.liacs.nl/pdf/2020-2021-VoetterRobin.pdf)、[著者コード](https://github.com/Snektron/pareas)
- Alpacc は terminal span と parent index を持つ preorder 配列、cuJSON は構造文字と対応位置の配列を使う。どちらも再帰オブジェクトの木を GPU の出力 ABI とする必要がない例である。— [Alpacc](https://github.com/diku-dk/alpacc)、[cuJSON](https://github.com/AutomataLab/cuJSON)

### Inferences

**提案する文法上の選択。どれも LLP への所属の十分条件ではなく、生成器で衝突・未対応を検査する。**

1. 宣言には `fn name(args): Result { ... }` の明示的なヘッダを必須にする。block は `{}`、group/call は `()`、array は `[]` などの visible delimiter、文は明示的 `;` で区切る。indentation と automatic semicolon insertion は初版に入れない。
2. 名前はすべて同じ identifier token にし、型名・constructor 名を先行宣言表で見て字句や構文を切り替えない。signature と binding resolution は別の意味パスにする。`<...>` を型引数と比較演算子の両方へ曖昧に使う構文も避ける。ユーザー定義の優先順位や宣言後に変わる fixity は初版に入れない。
3. コメントは当面非入れ子、文字列の delimiter は固定で、escape 規則も有限状態にする。無制限の入れ子コメントを9状態 DFA に押し込めない。macro を導入するなら lexer を書き換える文字列展開より、対応括弧を持つ token tree の後段変換を出発点にし、展開結果の文法検査と origin を別契約にする。

**提案する v2 IR。**

```text
SourceBytes
  -> TokenIR {kind, byteBegin, byteEnd}
  -> StructureIR {open, close, parentRegion, regionKind, firstToken, tokenCount}
  -> SurfaceIR {kind, childrenOffset, childrenCount, children[], sourceOrigin}
  -> Resolved / Typed IR
```

- `StructureIR` では文字列・コメント内部を除外した括弧に深さ scan を行い、実際の対応位置を求める。深さ別の安定した grouping / sort で同じ深さの open/close を対応させる案と、近傍探索案を比較する。`([)]` は総深さと総数だけなら通るため、型付き対応と prefix の非負性・最終ゼロを必須にする。括弧一致は文法の受理判定の代わりにならない。
- **関数列・引数列・block の文列・call の引数**を、binary `Sequence` の鎖ではなく `offset/count + flat children` にする。各列を独立 segment として scan / map できる形にする。巨大なグローバル RMQ 木を作る案と、region 内で局所処理し境界要約だけを結合する案を比較する。
- 同一優先順位の演算列は `InfixChain {operands[], operators[], evaluationOrder}` として表現する案を試す。**`a-b-c` の左結合は保持する**。parse IR を平坦にすることと演算を再結合して評価することは別問題。float、trap する overflow、effect を持つ operand を勝手に tree reduction にしない。連鎖の型検査・lowering のどこで依存が残るかを測る。
- 大きな木でも NodeId は整数にし、可変長辺だけを隣接配列へ分離する。全 node に source byte 数の容量を使うと現状の arena は大きいので、byte 軸の lexer scratch と token/node 軸の列の寿命を分ける。深さごとに入力全体の bitmap を作る方式は、深い program では補助メモリが深さに比例し得るため採用前に上界を評価する。

**UTF-8 と診断の契約。**

- byte offset を正本にし、`SourceId/revision + [begin,end)` を token と全変換の origin に保持する。CPU が文字・行番号へ表示変換する。GPU が raw bytes を受ける API に変えるなら UTF-8 validation を明示し、JavaScript string 化で壊れた byte 列が置換された後を検査したことにしない。
- chunk summary は「入口から出口の DFA 状態」だけでなく、必要なら入口状態別の最小エラー位置を持たせる。正しい入口が確定してから token・診断を確定し、escape / comment / 長い identifier が境界を跨いでも同じ span にする。
- nested block 導入後の回復単位は、正しい対応括弧と次の明示的宣言境界。壊れた region を後段へ渡さず、必ず前進する。現状の「最初の一件、全モジュールの AST を公開しない」をまず維持し、並行のエラー回復は別機能として検証する。

### Gaps

- 上の構造索引・平坦 IR・文法は提案。完成した LLP/C-OPG 文法の衝突検査をまだしていない。既存の演算子 Cartesian-tree パーサを全部捨てる根拠もない。
- arbitrary CFG / lexer mode / macro / indentation を、固定幅の有限 summary で安く処理できるという証拠はない。visible delimiter があるだけで効率的な完全 parser になるとは言わない。

## 3. 何を順に実装・比較するか

### Takeaway

文法検査・構造索引・平坦なリストの3点を先に固定する。scan の改良だけで高速化を宣言せず、最終結果とエラーの同値、全パスの bytes/dispatch、通常入力と小編集の時間で採否を決める。

### Cited Findings

- 現在の M5 snapshot は256関数、77,713 bytes、48,896 nodes で149 dispatch、arena 11,782,876 bytes、frontend p50 1,783.125µs、device p50 624.375µs。初期化・確保・encode/submit・最後の wait を frontend に含み、最終 JSON 化と library setup は除く。CPU は TypeScript oracle であり性能 baseline ではない。— [現行測定と方法](../../../../measurements/apple-m5.json)、[bench script](../../../../scripts/bench.ts)
- Pareas の研究は大入力での並列性と、小入力での scheduling/distribution overhead を区別する。C-OPG/Alpacc の研究が扱う local parsability は、全ソースを毎回作り直す構成を必須にはしない。— [Pareas 著者学位論文](https://theses.liacs.nl/pdf/2020-2021-VoetterRobin.pdf)、[C-OPG](https://pradella.faculty.polimi.it/papers/cyclop-ic.pdf)、[Alpacc](https://github.com/diku-dk/alpacc)

### Inferences

以下の採否条件は**実験案**であり、達成値ではない。

| 優先 | 実験 | 採否条件 |
|---|---|---|
| P0 | `let` / block / call を含む v2 文法を Alpacc などで検査し、手書き parser と比較できる契約を作る | 有効な生成入力・宣言破壊・型付き括弧不一致の受理/拒否が oracle と一致。衝突した grammar、必要 q/k、生成時間、表 bytes を記録。文法が未検証のまま機能を積まない |
| P1 | `StructureIR` の正しい対応括弧と region 分割。次の `}` を探す v1 索引を置き換える | `(())` / `()()` / `([)]`、深い入れ子、空 block、文字列内の括弧、全 byte の chunk alignment で結果・診断 span が一致。nested block で隣の関数に辺が漏れない |
| P2 | 宣言・文・引数を平坦化し、global RMQ と region 内局所処理を A/B 比較 | 同じ意味・エラー順で、representative な batch 全体の時間と peak memory が改善。operator chain の左結合維持。速い形の synthetic expression だけで採用しない |
| P3 | scalar sum/min の subgroup scan → 必要なら Decoupled Fallback。DFA 合成は別に評価 | 0/端数/複数 tile、三階層 scan、不規則長、非可換合成の正しさ、終了性、Metal validation が通る。scan 単体と全frontendの両方で改善。大入力向け経路が小入力を悪化させるなら閾値を分ける |

細かな測定案:

- 論理 Nanopass の数と physical dispatch の数を分ける。各パスの入力/出力 bytes、一時列の最大 bytes、scan/reduction 数を記録する。現状 arena は入力の約152倍という計算になるが、これは全てが同時に実際の有効データという意味ではなく、容量予約を含む。まず scratch の寿命と token/node の容量上界を直す余地を調べる。
- 標本は「多数の短い関数」「少数の巨大関数」「深い block」「長い演算列」「長い comment/string」「名前参照が多い入力」を分ける。入力 bytes 一つで選ぶより、token数・region数・最大region長・深さ・必要scratch量を記録する。
- 全9状態の lexer summary を36bit（状態当たり4bit）で pack する案と現在のベクトル表現を比較できる。ただし9状態を36bitへ収められるという表現上の計算であり、高速化の実証ではない。合成コスト・register pressure・table access を含めて測る。単に巨大な遷移モノイドの全合成表を作る方向へは進めない。
- 小編集は **byte chunk の summary tree + 宣言単位の cache** を候補にする。変更 chunk の summary 更新・合成は局所化できても、文字列やコメントの入口状態が変われば影響は後続へ伝播し得る。全 parser が常に O(log N) で更新できるとは主張しない。
- declaration 単位の stable ID と相対 span を持つ案なら、手前への挿入で後続全 token の絶対 offset/NodeId を書き換える費用を減らせる。`DeclId/generation + localNodeId` と、`SourceId/revision + declBase + relative byte range` を分離する。signature が不変の本体編集と signature 編集で無効化範囲を分け、小編集 batch をGPUへ渡す。単独の小編集でGPUが有利かはCPU比較で決める。

### Gaps

- region 内局所解析と全ノード Cartesian tree の優劣、C-OPG の GPU 対応、single-pass scan の DFA 合成への実利、incremental GPU parser の小編集 p95 は未測定。
- 「GPUに合う言語構文」の提案を、Bend/Mojo の現行仕様の説明や、それらの parser が自動的にGPU化されるという主張へ広げない。
