# CPU の状態管理と純粋 GPU 領域を組み合わせる実ワークロード

調査日: 2026-11-15。一次論文・著者実装・著者解説を使う。外部研究の CUDA／離散 GPU／分散実行の測定値を Apple M5 の性能予測には使わない。以下の入力規模、遅延目標、採用基準は **Metalic 向けの検証提案** であり、達成済みの数値ではない。

## どの実ワークロードなら CPU の状態管理と GPU の純粋領域が両立するか

### Takeaway

CPU が多数の状態を持つこと自体は障害ではない。GPU が使う snapshot の更新・commit を batch 単位にまとめ、次の GPU 段を決めるための host feedback を減らせる仕事が向く。全ビルド、IDE の一編集、要求ごとの状態遷移は、同じ言語処理でも別のワークロードとして比較する。

### Cited Findings

- **Pareas の著者実装／2022 年論文**: 単純な命令型言語を RISC-V 機械語へ変換する GPU コンパイラ。Futhark がコンパイラ本体、C++ が入力読出し・出力などを担い、frontend と backend が別にある。対応 backend は CUDA／OpenCL／C／multicore。大規模な既存言語や Metal の性能を実証した資料ではない。— [著者リポジトリと論文書誌](https://github.com/Snektron/pareas)
- **rustc 公式開発ガイド／2026-11-15 閲覧**: query は純粋関数で、query 間の依存が DAG を作る。変更の影響を受けない結果を再利用し、再評価しても結果が同一なら依存先への無効化の伝播を止める。— [Incremental compilation in detail](https://rustc-dev-guide.rust-lang.org/queries/incremental-compilation-in-detail.html)
- **GpJSON／PVLDB 18(9)、2025 年**: LD-JSON の構造 bitmap index を GPU 上で構築し、JSONPath の独自 bytecode interpreter で query も GPU 上で実行する。中間 index は GPU memory に残し、kernel 間で参照を渡す。CUDA 実装である。— [著者らの論文、§2–3](https://www.vldb.org/pvldb/vol18/p3216-bonetta.pdf)
- **Ray Data／最新確認版 v6、2026-10-21**: 中央 scheduler が batch ごとの task を動的に作成・配置し、CPU の I/O／前後処理と GPU の計算を pipeline 化する。task を大きくすると管理費用を償却できるが、保持メモリが増える。scheduler と dataplane を分離し、資源の再配分は partition 境界で行う。— [Ray Data: A dynamic and scalable system for heterogeneous data processing、§1–3](https://arxiv.org/html/2501.12407v6)（初稿 2025-01-16、版履歴は [arXiv](https://arxiv.org/abs/2501.12407)）

### Inferences

次表は上記の仕組みから導いた設計評価であり、Metalic の実測結果ではない。「境界」は CPU が GPU の結果を観測し、次の仕事を決める点を指す。GPU の kernel／barrier 数とは区別する。

| 仕事と具体的な入力形状 | CPU が持つ状態／GPU でまとめる領域 | 境界を越えるもの・頻度 | 主な評価軸・向き不向き |
|---|---|---|---|
| 一括 compiler frontend: 明示型の独立関数を 1／16／256 個。現状は一 source 最大256関数。識別子や式の長さは偏らせる | CPU: file graph、source version、cache。GPU: 字句→構文→束縛→局所型検査を flat IR で連結 | source／interface snapshot を最初に渡し、診断 summary と IR handle を最後に一度返す提案。全 AST を CPU で作る API は別測定 | 件数・bytes/s と全体完了時間。多数の独立関数なら候補。ただし frontend 高速化を全コンパイラ高速化とは扱えない。公開 IR handle は未実装 |
| 将来の full compiler build: 多数の関数＋import／call graph | CPU: package／I/O／cache／link。GPU: 独立関数の局所 pass、または依存成分ごとの pass 群 | interface を各関数ごとに照会すると細粒度往復。明示 interface を先に確定して依存階層ごとに batch 化できれば減る | backend、最適化、object 出力、link まで含む wall time。現在の Metalic には未実装 |
| IDE の一編集: 大きい workspace の 1 関数本体だけ変更、signature は同じ | CPU: dependency invalidation、editor version、取消し。GPU: dirty region のみ | 最新 version の dirty work と必要な診断のみ。再利用が効けば GPU に渡す仕事そのものが小さくなる | p95 編集→診断、取消し後の無駄仕事。全ファイル GPU 再処理より、CPU の増分再利用が有利になる可能性が高い |
| log／JSON ETL: 多数の独立 record を batch、規則や schema は低頻度更新 | CPU: file/network、schema registry、rule version、offset、retry、commit。GPU: parse→projection→filter→集計 | batch と不変 rule snapshot を投入、最後に集約結果・選択 row・失敗箇所を返す。commit は batch ごと | stateful CPU の有望例。状態は複雑でも更新回数が少ない。throughput と batch 待ち込み latency の両方を測る |
| 分析 query／read-only rules: 常駐 column／index に複数 query | CPU: query plan、認証、snapshot version。GPU: scan→filter→join／aggregate | plan／scalar parameter が入り、小さい集約値が返る。入力本体と中間列は常駐 | 大きな resident working set と小さな結果が有望。返却選択率が高く全 row を CPU object 化する場合は別条件 |
| sparse graph／到達可能性／単調な program analysis | CPU: graph version、checkpoint／方針。GPU: frontier→advance→filter→reduce | frontier count／changed flag は小さいが、各反復で CPU 判断すると反復回数だけ直列往復 | 広い frontier は候補。長い chain・高直径で frontier が細いと厳しい。worklist 管理と収束も可能な範囲で GPU 領域に閉じる |
| request-driven stateful service／UI callback: 1 件のイベントで条件分岐→状態読出し→次要求 | CPU: session／transaction／UI object graph。GPU: ごく短い純粋 helper | helper ごとに結果を待ち次のキーや I/O を決める。小出力でも依存鎖が長い | 低 latency／tail が重要な負例。独立要求の batch 化は queue 待ちを増やし、同一状態への逐次更新はまとめられない場合がある |
| frame ごとの多数 transform／粒子／画像処理／UI の大きな一括計算 | CPU: input、scene／UI state、frame version。GPU: 同一 snapshot への大量変換 | 通常の入力イベントを集約した snapshot を一度渡す。GPU 結果を描画に直結できれば readback 自体を省ける | ゲーム・UI 全体を不向きとはしない。細かな callback と大きな frame batch を分ける |

**歩き方 1: 多数関数の全処理と一編集を分ける。**

全処理では、CPU が source と宣言 interface の不変 snapshot を作り、GPU で `lex → parse → bind → type-local → diagnostics-summary` を連結する。span／node／binding は flat buffer に残し、CPU は summary または後続 backend が必要な部分だけ読む。各 nanpass の出力件数を CPU へ返して次を決める設計にすると、論理 pass 数が同期数へ直結する。nanpass は検証・意味論の単位であり、host 呼出しの単位に固定しない方がよい。

一編集では、CPU が version と query dependency graph を使って dirty 関数だけを特定する。signature が変わらない本体変更と、広範な依存先を無効化する signature 変更を分ける。純粋な query であることは GPU 並列化だけでなく **仕事を再実行しない** 最適化にも使える。GPU を既定にするより、dirty bytes／node 数／同時独立関数数／deadline から実行先を選ぶ候補にする。

型推論・generic 特殊化・依存型の正規化・global optimization のような前段結果に依存する仕事まで、現在の独立関数 frontend と同一視しない。明示 interface があれば局所 body check を並列化しやすい、という限定した仮説をまず検証する。

**歩き方 2: CPU は高度に stateful、GPU の入力は低頻度で確定する ETL。**

CPU が `offset range + schemaVersion + rulesVersion` を予約し、その不変 snapshot と log batch を GPU へ渡す。GPU は `structural index → field projection → predicate → local/group aggregate → compact output` を行う。CPU は結果 delta を検証して transaction を commit し、offset を進める。次 batch の読出しと既に確定した規則の準備を、前 batch の GPU 処理に重ねる。

CPU が持つ schema、進捗、retry、transaction のコード量が多くても、GPU の record ごとに CPU へ戻らなければ GPU 領域は大きく保てる。ただし「規則を同一 batch 中に更新して即座に次 record に反映」「各 record の更新結果で次 record の判定が変化」という意味論なら、snapshot batch 化は挙動を変えてしまう。安全にまとめるには、batch snapshot の許容、可換な集計 delta、commit 時の競合検出、または独立 key への分割が必要になる。

GPU から 1 byte の flag しか返さなくても、CPU がその flag を見て初めて次の 1 record を作る構造では overlap できない。逆に MB 単位の結果でも CPU の次段と pipeline を作れるなら、単純な「readback bytes が小さいほど良い」では判定できない。

### Gaps

- Pareas は「全段を GPU 向けに再設計したコンパイラは実装できる」例であり、既存の高性能コンパイラ、Bend の依存型 checker、Metal／M5 で end-to-end に勝つ証拠にはならない。
- ETL の commit／retry の具体設計と正しさは提案。ここでは transactional GPU ETL 実装を検証していない。GPU の純粋領域の正しさと、外部副作用の exactly-once は別契約になる。
- UI の event callback と frame batch の評価は設計上の区別であり、本調査ではゲームエンジンや UI framework の end-to-end 測定を収集していない。

## なぜ CPU の仕事が小さくても協調で負けるのか

### Takeaway

評価すべきものは CPU の処理割合に加え、結果依存の往復回数、並列に重ねられる量、中間 materialization、各反復の frontier 幅である。純粋性・アフィン制約は実行の合法性を与えるが、十分な並列性や粒度を保証しない。

### Cited Findings

- **Crystal／2020-03-02**: CPU から各 query の入力を送る coprocessor model と、GPU に working set を置く model を区別する。論文は効率的な CPU SIMD 実装を比較対象にし、full query を合成する tile primitive によって中間 materialization を減らす。PCIe に関する帯域値は Apple UMA へ移せないが、弱い CPU baseline や単一 operator の比較で全体性能を判断できない点は参考になる。— [論文 §2–3](https://arxiv.org/html/2003.01178)、[提出日](https://arxiv.org/abs/2003.01178)
- **Gunrock 公式 API 文書／2026-11-15 閲覧**: frontier は active working set を表す。host で作成して device で利用でき、要素数取得は表現によって stream を必要とする。拡張時の再確保・移動は高コストとなるため余裕を持つ容量管理を行う。— [Programming Interface Walkthrough、Frontier](https://gunrock.github.io/gunrock/gunrock.wiki/API.html)
- **SEP-Graph／PPoPP 2019、2019-02-16–20**: graph 形状によって push／pull、worklist の有無、sync／async の有利さが変わる。high-diameter graph の traversal では反復回数が増える。論文の比較では road_usa の SSSP で Gunrock が 6791 回 kernel を発行する一方、SEP-Graph／Groute は kernel を一度発行する構成を使う。これは NVIDIA 実装の結果であり、Metal で同じ永続 kernel を安全・効率的に実装できるという主張ではない。— [著者公開論文、§3、§5.2](https://xiaodongzhang1911.github.io/Zhang-papers/TR-19-1.pdf)
- **Futhark 著者解説／2026-10-02**: sparse Jacobian の前処理である sequential graph colouring について、GPU 配列の要素を CPU loop が一つずつ読むと、設定・blocking の費用が支配する例を説明する。`#[cpu_function]` で入力・中間計算を CPU にまとめ、結果を最後に bulk copy することで、後続 Jacobian を GPU 並列のまま実行できた。記事は著者経験の報告であり、Apple UMA の比較 benchmark ではない。— [Keeping Futhark off the GPU](https://futhark-lang.org/blog/2026-10-02-cpu_function.html)

### Inferences

**歩き方 3: CPU に返す値は小さいが、高直径 graph は往復が多い。**

CSR graph、visited／lattice value、current／next frontier を GPU に置く。各反復の仕事を `advance → filter/deduplicate → reduce(count, changed)` とする。CPU が毎回 `changed` を読み、次の command を作る設計なら、CPU の判断が数命令でも反復の依存鎖は縮まらない。chain graph では frontier が 1 個程度のまま長く続き、GPU の幅も使えない。これは低い CPU 使用率と GPU 高速化失敗が両立する例になる。

別の graph では大きい frontier が数回で広がり、その途中に同じ反復があっても GPU の仕事量が十分ある。V／E 数だけを揃えても評価は同じにならない。少なくとも chain／grid／広い tree／degree-skew graph と、frontier 幅・反復数の推移を記録する。

CPU の収束確認を q 反復ごとへ減らすなら、device 側の `active` flag で収束後の段を no-op にし、事前 encode した pass 群を進める候補がある。ただし余分な発行・mask 処理が増え、早期停止の待ち時間が長くなる。全 threadgroup を任意に同期する busy-wait や CUDA の persistent worklist をそのまま Metal に移すことは前提にしない。まず既存の dispatch／barrier の仕組みで、同じ有効仕事を保つ比較を作る。

言語設計上は、領域の外から純粋に見える関数でも、内側の unique buffer を in-place 更新してよい。`frontier` や monotone lattice の内部更新まで CPU の外部可変状態と同じ扱いで禁止すると、GPU 向け algorithm を不必要に制限する。必要なのは、外部 alias を持たない所有、更新の競合規約、barrier の意味、出力の決定性などを契約にすることだと考える。

Futhark の例は CPU 側にまとまった前処理を残すことの根拠になる。微小な純粋式を無条件に GPU へ分割するより、**CPU の sequential island と GPU の parallel island をそれぞれ大きくする** 方針が有望。自動配置 IR にも pure/effect の区別だけでなく、resident buffer、dirty region、結果依存、処理件数、deadline を残す必要がある。

### Gaps

- SEP-Graph の kernel 発行数は GPU 内 algorithm／launch overhead の例であり、各回に CPU readback したことや readback 単独の費用を意味しない。Metal での host feedback 実験は別途必要。
- GPU 内 checkpoint 間隔 q を増やしたときの M5 の損益分岐、indirect dispatch の費用、frontier 管理方式の優劣は未測定。
- Futhark 記事の倍率・per-element の時間は正式な hardware 条件を揃えた測定ではないため、このノートでは M5 の遅延予測に使用しない。

## Metalic で次に何を比較すれば設計の可否を判断できるか

### Takeaway

第一優先は同じ frontend の有効仕事を使い、GPU 常駐 pass 列と強制 host feedback を比較すること。次に snapshot ETL と細い frontier を対照にし、純粋な仕事量・返却量・同期回数を独立に変える。常駐 native CPU baseline と API 全体の測定が揃うまでは「CPU より高速」と結論しない。

### Cited Findings

- **Metalic 現状／2026-11-15**: 256 関数、77,713 bytes、48,896 node の既存測定は 77 dispatch／host wait 1 回。frontend 計測から process／library setup、最終 AST materialization、JSON encoding／IPC／JS parse が外れている。最後の一標本の AST 構築は約 24–28 ms。pool は同一 native request 内で再利用し、API 呼出しをまたぐ常駐 worker ではない。— [バッファ再利用の比較検証](../../reports/バッファ再利用の比較検証.md)
- **Metalic 現状／2026-11-15**: GPU 経路へ中間 count の host readback を加えないこと、TS oracle を最適化済み CPU baseline としないこと、当面 MSL 4.0 で進めることが契約。— [AGENTS.md](../../../../AGENTS.md)

### Inferences

以下は実装前の実験案。入力生成 seed、source hash、CPU／GPU 実行条件を保存する。強制 feedback 経路は比較実験専用に隔離し、通常 GPU API の契約を変えない。

| 順序 | workload・仮の入力範囲 | 同じ有効仕事で比べる treatment | 特に分離して測るもの |
|---|---|---|---|
| 1 | 現在の frontend: 1／16／256 独立関数、source 4 KiB〜1 MiB の対応範囲。長い単一式、短い多数関数、正常／少数診断／多数診断。編集 trace は body の 1 か所変更と全 source 差替えを分ける | A: native CPU、B: 全 pass GPU 常駐・最後に 1 回 completion、C: B と同一 kernel／同一 launch range のまま pass-group ごとに count を読んで再開。host 確認 1／4／16／全群。D: count による発行量縮小は別 experiment | summary／GPU IR handle と全 AST JSON を別 API として測る。C は発行量を減らさず同期の因果差を測る。D と混ぜない。現在は call／let／if や full compiler backend がなく、この benchmark を全コンパイラと呼ばない。一 source の MaxFunctions は256。4096関数は上限拡大や未実装の multi-source packed batch を別途設計してから評価する |
| 2 | 独立 NDJSON log: 仮に 64 KiB／1 MiB／16 MiB batch、同一総 bytes を 1／16／256 batch に分ける。固定 schema と 3〜8 個の projection／predicate／aggregate。出力選択率 0.1／10／100%。rule 更新は 1／16／256 batch ごと | A: native CPU SIMD／並列、B: parse→filter→aggregate の GPU 常駐、C: 各 operator 後に host が結果 count を読み次を開始、D: record ごとの CPU rule callback。いずれも同じ rule snapshot／出力を保つ | 入力待ち・CPU decode／copy・GPU・summary／選択 row の返却・CPU commit を分ける。複数 in-flight と 1 slot を別条件にする。ruleVersion の一致と offset commit 順序も照合 |
| 3 | monotone reachability／BFS: 仮に 10^4／10^5 頂点、疎な E、chain／2D grid／広い tree／degree-skew graph。同じ graph で複数 source | A: native CPU frontier、B: GPU frontier 常駐で q=1／4／16／64 checkpoint、C: 同じ反復を毎回 host 判断。まず固定反復数の同じ仕事で境界費用を比較し、別に正しい早期停止を含める | frontier-size trace、反復数、空反復の dispatch 数、atomic／compaction work、完了までの CPU wakeups、peak frontier capacity。graph の upload／構築込みと常駐後の query を別に報告 |

現状を短く判断するには **1 と 3** が最も直接的。1 で大きな常駐 pass 列の利益、3 で頻繁な結果依存の限界を、同じ機械・API で見る。汎用用途としての価値を評価する段階で 2 を足す。2 は「状態の多い CPU と大きな GPU 領域が両立する」反例を示しやすいが、現状の言語 frontend 拡張とは別 workload になる。

共通の baseline と計測契約は次のようにする。

- **CPU baseline**: clang `-O3` 等の native 実装で、同じ診断優先順位／UTF-8 span／overflow 規則／結果を生成する。最初は flat IR の同 algorithm を比較し、次に CPU に自然な fused／SIMD／incremental 版も測る。小入力は single-thread、多数独立入力は multicore を用意する。CPU が不要な中間 buffer を生成するよう強制して GPU を有利にしない。
- **二つの時間**: (a) 同一 process、warm library、resident buffers の処理時間、(b) source／request 受付から利用可能な結果までの全時間。cold CLI、warm 常駐 worker、queue/batch wait は別表示。最後の AST 構築、JSON serialization、IPC、CPU 消費を含める範囲を明記する。
- **共通指標**: useful records/functions/s、end-to-end p50／p95／p99、host feedback 回数、dispatch 数、CPU 実働時間／wakeups、GPU interval、準備・encode・completion wait・materialization の各区間、入出力と初期化 bytes、peak pooled capacity。CPU/GPU の各中央値を足して end-to-end 中央値にしない。
- **出力の同等性**: summary 版を CPU の全 AST JSON 版と比較しない。checksum のみなら全方式とも同じ checksum、診断なら byte/code／順序、ETL なら全選択結果か同じ集約値、graph なら全 visited/distance を照合する。性能 run の後にだけ correctness を確認する方式も含め、確認の費用範囲を揃える。
- **同期の因果を分ける**: B と C で useful work、kernel、launch bounds、pass 列、最終出力を同じにする。中間 count を読むことで dispatch が縮む実験や、kernel fusion により memory traffic が減る実験を別にする。複数要因を同時に変えた比率を「readback cost」と呼ばない。
- **増分の公平さ**: IDE 比較で CPU だけ全再計算／GPU だけ cache、またはその逆にしない。dirty work の確定、version 取消し、再利用率を含む edit trace を両方式に適用する。将来の実装案であり、現在に query cache があるという主張ではない。

仮の採用基準は、正しい結果を揃えたうえで、対象 workload の **全体時間** が測定揺らぎを超えて改善すること。たとえば throughput 用途で CPU 比 1.2 倍以上を目標に置くなら、その 1.2 は研究から導いた値ではなくプロジェクト側の KPI になる。interactive 用途の 1／10／100 ms といった deadline も仮の感度分析点にし、実際の製品要件とは分ける。CPU/GPU 自動選択は 1 回の microbenchmark で固定せず、resident 有無・batch size・dirty work・結果量・queue 待ちを入力とする測定済みの cost model にする。

### Gaps

- 現在の native CPU 性能 baseline と常駐 worker の end-to-end trace がない。既存 TS oracle／warm frontend の値から CPU 比 speedup や API latency を算出できない。
- 提案 2／3 の実装・測定は未着手。入力容量は仮定であり、frontend の現状上限を ETL／graph にそのまま適用したものではない。
- 本ノートの比較は MSL 4.0 で始められる範囲を想定し、4.1 の機能を必要条件にしていない。persistent kernel、全 GPU 同期、動的 GPU command 生成の可否・利益を前提にはしない。
