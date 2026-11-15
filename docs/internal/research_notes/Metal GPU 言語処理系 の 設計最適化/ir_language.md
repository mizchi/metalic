# GPU に適した IR と言語設計

調査日 2026-11-15。実装は変更していない。以下の「提案」は文献を根拠にした本プロジェクト向けの推論であり、論文が Metal 上の言語処理系を実証したという意味ではない。

## IR とナノパスをどう設計し直すか

### Takeaway

最重要は **意味上のパス境界・不変条件と、物理バッファの生成・kernel dispatch を分離すること**。v2 は関数・scope の segment を第一級にした列 IR を保ち、map/scan/compact の合成と粒度を schedule 側で選ぶ。

### Cited Findings

- **Scan-scatter fusion**、Troels Henriksen、2026-03-24。著者による実装解説であり査読論文ではない。scan の epilogue に map を融合し、scatter を accumulator 更新へ表すことで scan→scatter も同じ融合機構で扱う。正確な出力長を途中で読んで確保・分岐すると融合を妨げ、容量を先に確保して論理長を最後まで遅延させる構造が有利になる。ただし記事時点では実装未完成、融合 chain の scan は一つという範囲。AMD HIP の測定を Metal の期待速度に流用しない。— [公式解説](https://futhark-lang.org/blog/2026-03-24-scan-scatter-fusion.html)
- **Full flattening of nested data parallelism**、2026-07-31。著者・実装プロジェクトの解説であり査読論文ではない。不均一な map を細かな操作へ fission し、segmented operations へ変換して flat な GPU 実行へ落とす。並列化可能でも細かな分岐をすべて flatten すると管理費で遅くなる例を報告し、逐次化の選択を残している。— [公式解説](https://futhark-lang.org/blog/2026-07-31-full-flattening.html)
- 7月記事の「soon-to-be-merged」は現時点の状態ではない。**v0.27.1 の実在する release** に nonuniform nested parallelism 対応が掲載されており、実装済みと確認できる。ただし全ケースで効率的とはしていない。— [v0.27.1 release](https://github.com/diku-dk/futhark/releases/tag/v0.27.1)
- **Hercules: A Compiler for Productive Programming of Heterogeneous Systems**、Russel Arbore ほか、arXiv v1 2025-03-13。Juno の意味と imperative schedule を分離し、Hercules IR の fork/join・collection・control token を変形して outlining、fusion、CPU/CUDA codegen を行う。これは **GPU 向けにコンパイルする compiler** の設計で、compiler 自身が GPU 上で走る証拠ではない。— [論文本体](https://arxiv.org/html/2503.10855v1)
- **Verifying Properties of Index Arrays in a Purely-Functional Data-Parallel Language**、Nikolaj Hey Hinnerskov、Robert Schenck、Cosmin E. Oancea、arXiv v1 2025-06-29。配列を index function として扱い、map/scan/scatter/loop の pre/postcondition を伝播・証明して動的検査を削減する。任意の compiler IR 全体の正しさを証明した論文ではない。— [論文 PDF](https://arxiv.org/pdf/2506.23058)
- Futhark の開発中 changelog は、scan に融合した safety check の失敗で barrier divergence/deadlock が起きる修正も記録する。検査を融合するとき、失敗した lane だけを barrier 前で抜けさせる設計にはできない。— [公式実装の changelog](https://github.com/diku-dk/futhark/blob/master/CHANGELOG.md)（取得 blob SHA `12b0d7fa525020eda2028f9ce19346ebac5287f7`）

### Inferences

**v2 の意味上の IR chain 案**。この表は新しい設計提案。

| IR | 主な列・構造 | 次段へ渡すコントラクト |
|---|---|---|
| `SourceBatch` | source byte slab、`fileOffsets`、`fileLengths`、revision、immutable owner | ファイルごとの区間が非重複。変更中の入力を GPU が読まない |
| `TokenColumns` | kind、fileId、byteBegin/End、NameId、`count/capacity` | span がそのファイル内。NameId の等価性は byte 列の等価性を保証 |
| `RegionScopeColumns` | delimiter pairs、parentScope、function/body ranges、signature、parameter segment | 閉じ波括弧の単純な次位置ではなく、対応する delimiter を使う。すべての token が region に所属 |
| `ResolvedNodeColumns` | kind、ownerRegion、scopeId、binderId、calleeFnId、operand offsets/IDs | 参照が可視な宣言へ束縛。可変 arity の呼び出しも CSR 形式で表す |
| `TypedRegionANF` | typed values、let bindings、call args、if regions、region args/yields | すべての値に型。効果と評価依存が明示され、各定義は単一代入 |
| `OwnershipCheckedIR` | move/borrow mode、各 region の consumption summary | 同時実行・逐次実行の resource 使用と排他分岐を区別。未完了 buffer の寿命を保つ |
| `PassPlan` → `TaskGraph` | map、segmented scan/reduce、compact、join、tree fold、reads/writes、依存辺、completion | 意味を保つ schedule を選択。配置・fusion・容量・dispatch はここで決める |

`TokenColumns` 等は **論理的な view** でもよく、毎段別バッファへ materialize する義務はない。検証モードでは途中 IR を保存し、最適化モードでは列の liveness を解析して使い終わった領域を再利用する。公開 API では buffer handle と count/capacity/region metadata を持つ owner を返し、JSON dump は最終的な診断・表示のための選択肢にする。

最初の fusion 候補は、token start scan→token scatter、node flag scan→node scatter、名前解決→既知型 seed、型局所検査→最小診断 reduce。scan の複数 group 間の prefix 依存は消せないので、単に二つの kernel を連結しただけで融合できたとしない。必要な prefix 伝播の後の最終書き出しへ consumer の処理を入れ、rank 列の保存を省く案を比較する。

意味上の error-stage priority も契約にする。構文エラー時に型エラーを先に返さないなど、融合の前後で受理・拒否・診断位置を一致させる。barrier を含む kernel は全 lane が参加し、無効 lane は identity/mask を使う。assert に失敗した lane が単独 return する設計は避ける。

### Gaps

- 上記資料は Futhark の Metal backend を実証していない。公式 basic usage は共通 frontend/optimization pipeline と複数 backend を説明するが、採用対象は **アルゴリズム・IR の設計**であり「Futhark に置き換えれば Metal で動く」ではない。— [公式 usage](https://futhark.readthedocs.io/en/latest/usage.html)
- 今回の新しい探索で、2023–2026 の一般言語 compiler 全体を GPU 上で高速化した、今回より直接的で強い実証を追加確認できなかった。既存調査の Co-dfns/Pareas は引き続き直接の先例。Hercules、Futhark、MLIR を ON GPU の成果として数えない。

## 名前解決・型・affine 検査に合わせて言語をどう制約するか

### Takeaway

次の言語拡張は、型を明記した関数呼び出し、`let`、構造化 `if` に絞る。関数 signature を先に全収集すれば、本体の型検査を関数ごとの独立 segment にできる。affine の検査は文字列出現回数ではなく、構造化された実行経路の使用量の上界を合成する。

### Cited Findings

- **Towards Efficient Hash Maps in Functional Array Languages**、William Henrich Due、Martin Elsman、Troels Henriksen、arXiv v1 2025-08-15。可変長 string key を source context の offset/length として表す、静的な二段 collision-free hash map を Futhark で実装する。期待 O(n) work、O(log n) span の構築を示すが、CUDA cuCollections は構築・lookup とも速く、純粋な配列語彙・codegen の制約も原因とする。hash map を入れれば速くなる、sort/join にすれば最適、のいずれも言えない。— [論文本体](https://arxiv.org/html/2508.11443v1)
- affine な条件分岐では、両分岐に同じ開始 context を与え、終了後に両方で利用可能な変数だけを残すことができる。片方で消費された値を `if` 後に使えることにはできない。— [Jesper Cockx の一次講義ノート「Substructural Type Systems」](https://raw.githubusercontent.com/jespercockx/lbss-lecture-notes/master/07_substructural_type_systems.md)（最新論文ではなく標準的な型規則の根拠）

### Inferences

実装可能な最小 v2：

```text
fn choose(flag: bool, x: u32, y: u32): u32 {
  let z: u32 = add(x, 1);
  if flag { z } else { y }
}
fn add(x: u32, y: u32): u32 { x + y }
```

- 関数の引数型と戻り値型を必須にし、すべての signature を本体の前に得る。直接 call の出力型は callee body の推論完了に依存しない。前方参照・再帰の型検査も signature だけで閉じられるが、再帰の評価・stack 設計は別課題。
- `let` はまず型注釈必須、単一代入、構造化 block、`if` は `bool` 条件と同型の二つの yield に限定。overload resolution、ADL、暗黙変換、実行を伴う型計算、untyped macro を初期段階に含めない。これは性能が実測済みという主張ではなく、依存関係を限定する設計上の選択。
- 識別子 byte 列を参照のたびに読み比べず、intern 済み `NameId` で比較する。hash の一致だけを名前の一致としない。collision を元 byte 列で検証し、source slab の寿命を NameId dictionary の契約に含める。
- 現在の引数上限64程度では、整数 NameId の小さな線形探索が、大きな table 構築・sort より安い可能性がある。大きい package の global 名は `(namespace, NameId)` の sort/join、静的 hash map、SIMD 協調 probing を比較する。構築費込みで測る。
- `let` と shadowing を認めるなら `(scopeId, NameId)` を sort するだけで名前解決は完了しない。使用位置、定義位置、親 scope、可視区間の判定が必要。初版は shadowing を禁止するか、小 scope の親たどりを残して段階的に最適化する。禁止する場合も兄弟 block の値が外へ漏れないことを visibility interval で検査する。

**affine の最小で検査可能な設計**：Copy scalar と affine owner を区別する。構造化され、loop/closure/aliasing mutation を持たない段階では、各外部 affine binding に対する使用量を `{0,1,2+}` で表し、以下の summary を bottom-up に合成できる。

```text
sequence/argument evaluation: use(a;b) = sat_add(use(a), use(b))
exclusive if: use(if c then a else b) = sat_add(use(c), max(use(a),use(b)))
parallel fork: use(a || b) = sat_add(use(a),use(b))
```

`2+` が出た binding を拒否する。`if c { consume(x) } else { consume(x) }` は一経路で一回なので受理できるが、その `if` の後の `consume(x)` は拒否する。並列 fork は両方実行するので max にはできない。`let y = x` は x の消費と y への所有移動を表し、単なる alias としない。関数境界には consume/borrow/Copy の mode を持たせる。ループ、再帰で捕捉する owner、共有 borrow の寿命が入れば、単純な有限木 summary だけでは足りず、追加の規則・不動点・escape 検査が必要。

これは保守的な検査であり、二つの `if` の条件が論理的に排他的であることまで推論しない。alias のない構造化 core で sound な制約を先に定義し、完全性や高度な borrow analysis を主張しない。

この summary を binder 次元の疎な segment として合成すれば GPU 向けになるが、全ノード×全 binder の密な行列にはしない。最初は関数・region 内で局所 bitset、長い関数だけ sparse merge を比較する。型パスが GPU であること自体がメモリ安全性の証明にはならない。

### Gaps

- 上の max/saturated-add アルゴリズムは **この制限した言語向けの提案**。一般の affine/borrow checker、依存型 checker がこの方法で効率よく動くことは資料から示せない。
- 参照の局所性・名前の長さ・scope 数の corpus 計測がなく、linear search / sort / hash の選択閾値を設定できない。

## 配置と実験をどの順番で進めるか

### Takeaway

CPU/GPU の選択単位は単独 node・単独ナノパスより **連続した処理 region** に置く。daemon 内の library/arena を再利用し、tiny edit は CPU、大きな ready batch は GPU という少数の決定的 policy から実測で較正する。ただし現時点で byte 数の切り替え閾値は未確定。

### Cited Findings

- **Concurrent Scheduling of High-Level Parallel Programs on Multi-GPU Systems**、Fabian Knorr、Philip Salzmann、Peter Thoman、Thomas Fahringer、arXiv v1 2025-03-13。Celerity に instruction-graph を導入し、allocation・coherence・転送・kernel invocation の解析と実行を重ね、lookahead で allocation を最適化する。対象は SYCL accelerator cluster で、Metal UMA の速度実証ではない。— [論文本体](https://arxiv.org/html/2503.10516v1)
- Futhark 2026 の full flattening は、引き出せる並列性を増やしても過剰な分岐の flattening が遅くなることを示す。言語の意味から「最大限に並列化する schedule」を一意に決めるのではなく、局所逐次処理も実装選択として残す根拠になる。— [公式解説](https://futhark-lang.org/blog/2026-07-31-full-flattening.html)

### Inferences

現実的な優先順：

| 順位 | 変更・比較 | 採用を判断する測定 |
|---|---|---|
| P0 | correctness oracle と同じ意味の native CPU baseline、常駐 native runtime、arena/PSO 再利用、実際に複数 source を詰めた GPU batch。cold CLI と warm の分離 | 全体 wall time、p50/p95、throughput、memory。TS oracle から cutover を決めない |
| P1 | count/capacity と region metadata を維持して、scan→scatter の中間列削減、診断 reduce の統合 | dispatch 数、materialized bytes、読書き量、同一入力の E2E。エラー優先順位・GPU validation 不変 |
| P2 | function-size bucket を作り、小関数は thread/SIMD-group 内の逐次処理、大関数は segmented data parallel を比較 | 同じ総 node 数で関数サイズ分布・深さを変え、最悪偏りを含める。並列幅と group utilization |
| P3 | NameId intern と小 scope lookup、package 名には sort/join vs static hash | build+lookup 総費用、string 長、重複率、scope 深さ、table 再利用回数、collision stress |
| P4 | call、annotated let、if、ownership summary を導入し、dirty function batch のみ再処理 | full build / 1関数編集 / signature変更 / 深い鎖 / 大量の独立定義の trace。CPU/GPU の束縛・型・診断一致 |
| P5 | 上記の計測表から 2–3種類の region schedule を決定的に選択 | unknown workload 上の最良固定選択との差、policy 自体の時間、queue 競合、hysteresis による安定性 |

placement cost は単純な「GPU kernel が速いか」ではなく、入力が利用可能な時刻から consumer が結果を使える時刻までを見る。CPU ready 時刻と GPU queue ready 時刻、確保・encode・submit、必要な同期、最終 CPU consumer work を含め、重なる区間を二重計上しない。GPU 上の exact live count を host 配置器が読むためだけの追加 wait は作らず、ファイル byte 数・前回の function histogram・既知 batch 数等を使う。GPU へ載せた連続 region は途中で CPU に戻さず、意味上の pass ごとに貪欲に device を切り替えない。

incremental な作業単位を関数本体にするため、再利用 artifact は `(qualified definition key, body hash, signature hash, dependency versions)` で cache する。revision は in-flight snapshot の識別に使い、全ファイルの revision が変わっただけで無関係な本体をすべて無効化しない。function-relative span と revision ごとの file origin を分け、再利用した診断が旧 byte offset を返さないようにする。signature が変わらない body edit と signature edit は無効化範囲を分ける。ただし lexical state を変える編集は後方へ伝播し得るので、常に「編集した行だけ」を再 lex できるとはしない。

GPU-hosted frontend と GPU-hosted shader compiler も区別する。現試作の `newLibraryWithSource` は runtime の Metal kernel を host API 経由でコンパイルするセットアップであり、ユーザープログラムのコード生成は未実装。今後 Typed IR を直接評価する事前コンパイル済み interpreter/operator kernels と、MSL を生成して host 側の Metal compilation API に渡す backend は別の設計選択になる。後者の shader compilation と pipeline 作成の費用を frontend の GPU 時間へ隠さない。ICB 等の device-driven dispatch を使っても、任意の新しい MSL をそこでコンパイルできるという意味にはしない。— [現試作の host 実装](../../../../native/main.mm)

各最適化は Red→Green と独立した CPU/GPU differential test で意味を固定してから行う。fixture を小さく限定せず、長い識別子、最大深さ、大きい1関数、非常に多い短関数、空/不正入力、変更後の buffer 再利用を含める。full GPU 化が winner であることを前提にせず、E2E と memory のどちらで利益が出たかを記録する。

### Gaps

- 現試作の frontend 約1.78 ms と GPU interval 約0.62 ms は native CPU baseline との比較ではなく、各分布の中央値の差で「host overhead 約1.16 ms」と厳密に分解できない。保存済みの入力・計測は現状の基準点に留める。— [ローカル計測](../../../../measurements/apple-m5.json)
- **実 API の固定費は約1.78 ms より大きい。** `parseGpuModules(sources)` は呼ぶたびに子プロセスを起動し、native `Runtime` の library/PSO setup（snapshot の例で約28–33 ms）が frontend timing の外にある。native main は source を順に `run` し、各 source で待つ。現 API の「batch」は subprocess 起動をまとめる配列であり、複数 source を同一 GPU slab / command graph に詰めた並列 batch ではない。P0 の常駐化、実 packed batch、必要に応じた非同期 completion が先に必要で、CLI E2E を約1.78 ms と報告しない。— [TS adapter](../../../../src/gpu.ts)、[native driver](../../../../native/main.mm)、[計測](../../../../measurements/apple-m5.json)
- persistent scheduler や新しい device-driven execution を全面導入すべき証拠は今回の IR 文献からは得られない。まず列 IR・粗い batch・融合・資源再利用の利益を確認する。
