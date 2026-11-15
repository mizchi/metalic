# GPU 常駐コンパイラ・配列 IR・異種実行時の関連研究

調査基準日: 2026-11-15。一次論文、公式資料、実装者本人の説明を優先した。下記の設計案・実験値は提案であり、Metal で測定済みの性能ではない。論文のページ番号は本文の印字番号。

## 1. コンパイラ自身を GPU で動かす研究は何を実証したか

### Takeaway

Co-dfns と Pareas は、木・名前解決・限定された型検査まで配列操作で表現し、GPU で実行できる証拠になる。ただし、汎用の最適化コンパイラや依存型 elaborator 全体を GPU に移す優位性まで実証してはいない。GPU をターゲットにするコンパイラと、コンパイラ自身が GPU 上で走る構成を明確に区別する必要がある。

### Cited Findings

- **Hsu の博士論文（2019-11）の対象**は、構築済み AST を低位化し、レキシカルな名前の参照先を解決する中核変換である。「17 行」はこの部分を指す。BQN 実装者 Marshall Lochbaum の比較記事は、字句解析・構文解析・コード生成が別部分であり、全てが同じデータ並列性を持つわけではないと整理している。木は主に parent/sibling の添字配列として扱われる。記事更新日 2025-05-02。— [Hsu 論文の大学登録情報](https://scholarworks.iu.edu/dspace/items/3ab772c9-92c9-4f59-bd95-40aff99e8c7a)、[BQN 実装者による比較](https://mlochbaum.github.io/BQN/implementation/codfns.html)

- **Hsu 論文の正確な計測条件**（pp.144–150、PDF ページ154–160、図版を直接確認）: Xeon E5-2623v3、GTX 980/4 GB、Windows 10 1809、Dyalog 17.0.36301。CPU は Dyalog、GPU は C++/ArrayFire CUDA。Black–Scholes などを含む 1,019 ノードの AST（lexical depth 3、tree depth 15）を倍々に複製し、1,019〜1,019×2^14 ノードを測定。5 回平均。比較相手は同じパス構成の Racket/Chez Nanopass。主 GPU 時間には GPU への転送前後を含めず、転送時間は別掲する。したがって巨大入力の多くは、深さを増やさず幅を増やした合成入力である。— [大学所蔵の論文 PDF](https://scholarworks.iu.edu/dspace/bitstreams/dcbd5240-8454-4533-bc0c-ac3ee7628b8e/download)

- **自動 self-host の実証と混同してはいけない。** 2025-03-01 公開 ArrayCast、14:03–16:46 で Hsu 本人が、当時の17行を実行時プリミティブ、小規模な融合・インライン化を仮定して**手作業でコンパイル**したものを計測したと説明する。Key 相当には sort、indexOf には batched binary search を使った。本人によれば機械化は学位研究の範囲外だった。この説明は上記 BQN 記事とも一致する。「同一の意味的アルゴリズムを GPU に翻訳できた」と「製品コンパイラ全体が自分自身を GPU 向けに自動コンパイルした」を分ける。— [ArrayCast 第100回、14:03–17:15](https://www.arraycast.com/2025/03/01/The-100th-Episode-with-Aaron-Hsu.html)、[BQN 比較記事](https://mlochbaum.github.io/BQN/implementation/codfns.html)

- **Pareas / Voetter 修士論文（2021）**は、Futhark で字句解析・構文解析・意味解析を GPU 実行する別の直接例。対象は独自の命令型・手続き型・静的型言語で、LLP(1,1) 構文解析の制約を文法変換と追加検証で補う。型は少数の基底型と参照で、型変化を結合的な参照数の加算として処理できる。著者は複雑な型体系への一般化を未解決とする（§6.1.3）。— [大学の登録情報](https://theses.liacs.nl/2052)、[論文、§3–4・§6.1.3](https://theses.liacs.nl/pdf/2020-2021-VoetterRobin.pdf)、[実装](https://github.com/Snektron/pareas)、[計測コード](https://github.com/Snektron/pareas-frontend-benchmarks)

- **Pareas の計測の境界**（§5）: CPU は2×EPYC 7601、GPU は別マシンの RTX 3090 を1台使用、CUDA 11.2/GCC 10.2 -O3。CPU は1/4/16/64スレッド、各30回。Pareas 入力は5.17 KB〜183 MB、JSON は15.2 KB〜442 MB。生成した入力と実データを区別する必要がある。GPU の主要グラフとは別に、初期化平均4.6秒（JSON 2.0秒、CPU 2 ms未満）を報告する。著者自身が、全木を何度も読む GPU 寄りの設計、適切な CPU baseline の不足、小入力の同期費用、大きな一時メモリを限定として挙げる。— [論文、§5・§6](https://theses.liacs.nl/pdf/2020-2021-VoetterRobin.pdf)

- **診断や source location は配列方式と両立する実装例がある。** Lochbaum は BQN の source-position tracking とエラー検出を説明し、整形された説明をエラー発生時だけ別の処理で行う例も挙げる。一方で「どの順序のノード配列か」を混同するバグを、配列コンパイラの保守上の課題と指摘する。これは実装者の経験・評価であって GPU 上の診断性能の実証ではない。— [BQN 比較記事、Error reporting / Ease of development](https://mlochbaum.github.io/BQN/implementation/codfns.html)

### Inferences

- **構造の平坦化は木の意味を消すことではない。** NodeId と parent/depth/scope/source-span の列を持ち、scope ごとの segmented scan、gather、sort/group、prefix sum などへ変換する方向が有望。Hsu/Pareas が示したのは、この表現変更で再帰的に見える処理にも幅を作れること。Bend の依存型・affine checker に同じ分解が適用できるかは別途確かめる必要がある。— 根拠: [Hsu 論文](https://scholarworks.iu.edu/dspace/items/3ab772c9-92c9-4f59-bd95-40aff99e8c7a)、[Pareas 論文](https://theses.liacs.nl/pdf/2020-2021-VoetterRobin.pdf)

- **名前・型に状態があることから GPU 不可能とは結論しない。** 独立 scope/定義の処理、制約生成、局所検証、正規化要求のバッチなどには幅があり得る。一方、メタ変数の解決が次の制約を変える処理、深い依存鎖、共有する一意化状態には、競合管理や worklist/反復が必要になる。Pareas の「参照数の結合的な合計」と、一般の型推論・依存型の定義的等価判定は同じ問題ではない。— 根拠と未解決範囲: [Pareas §6.1.3](https://theses.liacs.nl/pdf/2020-2021-VoetterRobin.pdf)

- **旧ベンチの GPU 対 CPU 倍率を、Metal の期待倍率には使わない。** GPU 世代、別メモリか共有メモリか、CPU baseline、AST の幅/深さ、転送・初期化の包含範囲が異なる。特に Hsu の複製 AST は「幅を増やした大量独立作業」の根拠として読み、「深い依存鎖を解消する」根拠にはしない。— 根拠: [Hsu pp.144–150](https://scholarworks.iu.edu/dspace/bitstreams/dcbd5240-8454-4533-bc0c-ac3ee7628b8e/download)、[Pareas §5–6](https://theses.liacs.nl/pdf/2020-2021-VoetterRobin.pdf)

### Gaps

- この調査では、実用的な依存型 elaborator 全体、IDE の1文字編集、複雑なジェネリクスの単相化までを GPU 常駐で高速化した一次評価は確認できなかった。不可能という意味ではない。
- Hsu の GPU 手動翻訳が、現在の製品版でそのまま自動生成・self-host 可能かは未確認。2025 年の本人発言にもバージョン依存の留保がある。
- Pareas の end-to-end RISC-V 生成は別研究の範囲。ここでは frontend 論文の評価を、全 native toolchain の評価へ拡張しない。

## 2. 小さなパス、配列 IR、動的配置はどのように組み合わせられるか

### Takeaway

Nanopass は意味上の境界と中間言語の契約を明確にする。実行粒度は別に選ぶべきで、論理パス1個を物理カーネル1個へ固定する必要はない。StarPU は入力別の異種配置、Futhark は並列性の量に応じたコード選択、Halide は意味と schedule の分離、Taichi は Metal を含むホスト/デバイス分離の比較例になる。

### Cited Findings

- **Nanopass**: 公式サイトは「小さなパスと多数の IR」を中心に据える。`define-language` と `extends` は中間言語の構文を宣言し、`define-pass` は変換元/先の言語を指定する。Racket 版は record-based 表現を使う。これはパスの並列性や GPU 配置を自動的に与える仕様ではない。— [公式概要](https://nanopass.org/)、[公式にリンクされたユーザーガイド](https://docs.racket-lang.org/nanopass/index.html)、[Keep 博士論文（2012）](https://andykeep.com/pubs/dissertation.pdf)

| 比較例 | 実際に備える部分 | 本案へ使える考え方と境界 |
|---|---|---|
| **StarPU** | CPU/CUDA/HIP/OpenCL などの codelet、データ依存からの task DAG、実行時間モデル、局所性を考慮する scheduler | 同一タスクの実装を入力別に選ぶ直接例。カーネル自体は利用者が実装する。公式サポート一覧に native Metal はない。— [公式 Features](https://starpu.gitlabpages.inria.fr/features.html)、[README](https://github.com/starpu-runtime/starpu/blob/master/README.md) |
| **Futhark** | コンパイル時の複数コード生成と実行時の並列量による選択、閾値の autotuning | GPU 内でどの階層の並列性を使うかの例。一般の online CPU/GPU task placement と同一ではない。— [PPoPP 2019 原論文](https://futhark-lang.org/publications/ppopp19.pdf)、[著者の解説（2019-02-18）](https://futhark-lang.org/blog/2019-02-18-futhark-at-ppopp.html) |
| **Halide** | imaging/vision pipeline の algorithm と schedule の分離、モデルを使う GPU schedule 探索 | 意味パスと物理実行の分離に参考。学習した cost model でコンパイル時に schedule を探す方式で、任意の IR task を到着ごとに配置する実行時ではない。— [Anderson ほか OOPSLA 2021 原論文](https://cseweb.ucsd.edu/~tzli/gpu_autoscheduler.pdf) |
| **Taichi** | Python AST→Taichi IR→SSA 最適化→Metal などへの生成と実行、インスタンス別 cache | Metal を生成先にする実装例。コンパイラ自体を GPU で動かす証拠ではない。— [公式 Life of a Taichi Kernel](https://docs.taichi-lang.org/docs/master/compilation) |

- **StarPU の入力別適応は online 性を持つ。** codelet は同じ architecture に複数の関数を持て、入力サイズに応じて実装を選べる。履歴型モデルは online calibration を行い、マシン/デバイス別に保存される。未計測 task や実装変更には学習・再校正が必要。データ依存には RAW/WAW/WAR や明示的 tags、データ管理には再利用・prefetch がある。— [公式 Features](https://starpu.gitlabpages.inria.fr/features.html)、[Handbook §20.13](https://files.inria.fr/starpu/doc/html/CheckListWhenPerformanceAreNotThere.html)

- **StarPU をそのまま Metal の粒度モデルにしない。** Handbook は小さすぎる task を警告し、典型例として10 µs程度を不適切とするが、その文脈には CUDA の費用がある。これは Apple Silicon の dispatch 時間の測定値ではない。Metal 用の最小粒度・モデル特徴量は測り直す必要がある。— [Handbook §20.1](https://files.inria.fr/starpu/doc/html/CheckListWhenPerformanceAreNotThere.html)

- **Futhark の最新状況を古い制約で説明しない。** 2019 の incremental flattening は複数バージョンを生成し、外側並列量などの閾値で実行時選択する。2026-02-03 の著者記事もこの区別を説明。2026-07-31 には nonuniform な nested parallelism に対する full flattening を説明し、flat data+segment metadata、segmented scan を使う。融合は flattening 前に積極的に行い、過剰な中間配列を抑える方針。著者は再帰の制御が CPU 側へ移ることも説明する。したがって「Futhark は不規則並列性や再帰を原理的に扱えない」とは書かない。— [2019 原論文](https://futhark-lang.org/publications/ppopp19.pdf)、[2026-02-03 著者記事](https://www.futhark-lang.org/blog/2026-02-03-tuning-params.html)、[2026-07-31 著者記事](https://www.futhark-lang.org/blog/2026-07-31-full-flattening.html)、[2026-08-12 の後続記事](https://www.futhark-lang.org/blog/2026-08-12-flatmap.html)

- **Halide の autoscheduler 名にも境界がある。** 公式 CMake docs では Adams2019 は GPU 非対応、Anderson2021 は GPU 対応、Li2018 は限定的 GPU 対応と記す。2019 の学習モデルを根拠に GPU scheduler の実績を語るなら取り違えない。ここでは GPU 向けの2021論文を比較対象とする。— [公式 CMake 文書](https://halide-lang.org/docs/HalideCMakePackage.html)、[2021 原論文](https://cseweb.ucsd.edu/~tzli/gpu_autoscheduler.pdf)

- **Taichi は一つの backend を選ぶ方式。** 公式 develop docs は、同時に複数 backend を使うことに対応せず、`ti.init()` で切り替えると kernel が新 backend 向けに再コンパイルされると説明。従って `ti.gpu` の CPU fallback と task ごとの CPU/GPU 分散は別機能。さらに C API v1.6.0 の表は Metal を Tier 2/未安定とする一方、埋め込み tutorial には Metal 未対応の記述があり、Python Metal backend と AOT embedding の対応を区別する。— [Kernels and Functions](https://docs.taichi-lang.org/docs/master/kernel_function)、[C API Core](https://docs.taichi-lang.org/docs/taichi_core)、[C++ embedding tutorial](https://docs.taichi-lang.org/docs/master/tutorial)

### Inferences

- **契約単位と実行単位を分ける。** 例: `ResolveNames -> MarkCaptures -> CheckUses` を別の論理パスとして検査・説明しつつ、各 scope の読み取りを共有する物理 kernel に融合する。開発時は中間成果を materialize して比較し、通常実行では不要列・一時配列を書き出さない。Nanopass の中間言語契約と Halide の schedule 分離を組み合わせた設計仮説である。— 根拠: [Nanopass](https://docs.racket-lang.org/nanopass/index.html)、[Halide 2021](https://cseweb.ucsd.edu/~tzli/gpu_autoscheduler.pdf)

- **パスを小さくするほど速くなるわけではない。** 論理パス数 P と、全 IR を読む回数 R、物理 launch 数 K、host へ結果を返す回数 H を別々に数える。全体費用は概念的に `encode/submit + kernel work + intermediate traffic + synchronization + host-visible decisions`。共有メモリでも R/K/H と依存の直列部分は残る。Pareas の全木走査問題と Futhark の融合の難しさが、この区別の根拠になる。— [Pareas §6](https://theses.liacs.nl/pdf/2020-2021-VoetterRobin.pdf)、[Futhark 2019 解説](https://futhark-lang.org/blog/2019-02-18-futhark-at-ppopp.html)

- **融合にも契約が要る。** 要素単位の producer/consumer は融合候補だが、global sort/scan の結果を次段全体が必要とする場合、反復停止判定、別 scope への可変長 scatter、診断の順序付けは追加の同期・buffer を要し得る。logical pass の依存を隠して巨大 kernel にするだけでは critical depth は短くならない。— 根拠となる操作・実装: [Pareas §4](https://theses.liacs.nl/pdf/2020-2021-VoetterRobin.pdf)、[Futhark full flattening](https://www.futhark-lang.org/blog/2026-07-31-full-flattening.html)

- **CPU baseline は二つ用意する。** 第一に同じ flat/SoA IR を使う SIMD/マルチコア実装。第二に同じ意味的契約を満たし、全木走査を避ける強い CPU アルゴリズム。この比較で初めて「配列化の効果」「GPU の効果」「GPU に有利なパス構成による比較差」を分離できる。— 比較方法への警告: [Pareas §5–6](https://theses.liacs.nl/pdf/2020-2021-VoetterRobin.pdf)、[BQN 実装者の評価](https://mlochbaum.github.io/BQN/implementation/codfns.html)

- **型契約に軸と世代も含める。** `NodeId<IRGeneration>`、`Column<NodeAxis,T>`、`ScopeId`、`SourceSpan`、read/write region、並列 reduction の結合法則などを表現する案。`int[]` 同士でも異なるノード順序を混ぜない保証が必要。生 buffer の所有権だけでは意味的な添字整合性までは守れない。— 動機: [BQN 実装者が述べる axis/ordering 問題](https://mlochbaum.github.io/BQN/implementation/codfns.html)

### Gaps

- StarPU の公式サポート一覧で native Metal は確認できない。設計参照先としては強いが、Metal へそのまま導入可能という証拠はない。
- Taichi の Python Metal、C API、AOT embedding の機能表には版・経路の違いがある。実装対象を選ぶ際には commit とサンプルで確認する必要があり、表だけで相互運用を保証しない。
- Futhark の2026記事は著者の実装説明であり、この調査では新しい full flattening の Metal compiler workload 評価や採用版番号まで確認していない。
- Halide の画像パイプラインで成立する cost model が、不規則な型検査・制約解決にそのまま通用する証拠はない。

## 3. Metal を前提とする現実的な設計案と反証可能な実験は何か

### Takeaway

最初に試す価値があるのは、狭い DSL/大量解析を対象に「配列 IR を共有し、幅のある段階だけ GPU へまとめる」構成である。配置は入力バイト数だけで決めず、独立タスク数、依存深さ、一時メモリ、ホスト判断、実測した競合を使って選ぶ。以下は先行例から導く提案であり、性能の約束ではない。

### Cited Findings

- Hsu は浅い木を複製して幅を増やしたケース、Pareas は大きい入力と単純な型体系を評価する。これらは大量バッチの根拠になるが、深い依存や小さい差分の性能を直接支持しない。— [Hsu pp.144–150](https://scholarworks.iu.edu/dspace/bitstreams/dcbd5240-8454-4533-bc0c-ac3ee7628b8e/download)、[Pareas §5–6](https://theses.liacs.nl/pdf/2020-2021-VoetterRobin.pdf)
- StarPU は codelet の実装・入力・データ所在から実行を選び、Futhark は同じ意味の並列実装を複数作り閾値で選ぶ。両者は「実装を選ぶ前に、選択肢と予測対象を定義する」設計の先例になる。— [StarPU Features](https://starpu.gitlabpages.inria.fr/features.html)、[Futhark PPoPP 2019](https://futhark-lang.org/publications/ppopp19.pdf)
- 診断・source positions を持つ配列コンパイラも存在するが、配列軸・順序を追う保守負担がある。結果の正しさ・説明可能性を速度と同時に評価する必要がある。— [BQN 実装者の記事](https://mlochbaum.github.io/BQN/implementation/codfns.html)

### Inferences

#### 設計候補 A: 幅のある中核パスを常駐させるバッチコンパイラ

- CPU がファイル・依存解決・小さい編集・診断の表示を受け持つ。flat IR に入った大きな定義群は GPU にまとめ、名前解決、局所チェック、到達可能性・使用情報など適した処理を複数段続ける。
- 適した候補は大量の shader variant、限定された DSL、パッケージ全体の静的解析、独立定義の多い full build。LSP の小さい編集は差分領域を CPU で処理し、大きな再検証だけバッチ化する。 長寿命の compiler daemon なら初期化・kernel cache を複数 build に償却できる可能性があるが、差分が小さい限り GPU の実行粒度問題は残る。full build の throughput、短命 CLI の初回 latency、daemon の小編集 p95 を別の利用形態として測る。
- 棄却条件は、IR 構築・一時配列・global 同期を含めると強い CPU baseline を継続的に下回ること。また、full build で勝っても差分編集で悪化するなら、常時 GPU 配置という仮説だけを棄却して範囲を狭める。

#### 設計候補 B: 同じ buffer 契約に CPU/GPU 実装を持つ task DAG 実行時

- 意味的な task を、読取/書込領域、依存 event、実装候補、見積り資源量で定義する。affine な所有権・可変領域の排他と、task 完了 event を結び付ける。CPU/GPU のどちらに置くかは型そのものに埋めず、実行計画にする。
- scheduler は `N bytes、W independent items、D dependency depth、estimated temporary bytes、handoff count、queue delay` と直近測定を利用する。同じ作業でも、少数の深い鎖と多数の浅い鎖を別形状として扱う。
- StarPU の全機構を最初から複製せず、少数 task 種と事前計測表から始める。入力ごとに小さな task を切り替えすぎないよう、連続領域の配置、最低粒度、予測誤差に対する hysteresis を設ける。
- 適用先はコンパイラだけでなく、Metal 向けプログラム全体の CPU/GPU 協調にもなる。棄却条件はモデル・task 管理費用が節約分を上回る、または未知の入力で静的閾値より劣ること。

#### 設計候補 C: 小さい意味パスから物理 schedule を生成する DSL コンパイラ

- 論理 IR パスは小さく契約を厳密に保つが、その実装を map/filter/scan/sort/gather などの限定演算に落とす。CPU、GPU、threadgroup 内処理、融合した処理の複数 schedule を生成する。
- Futhark の並列性選択、Halide の algorithm/schedule 分離が参考になる。一般の依存型チェッカ全体の自動変換から始めるより、shader/画像以外も含む小さい純粋 DSL、既知のバッチ解析へ範囲を絞る方が検証しやすい。
- 反証点は、融合候補が少ない、変換で中間配列が増えすぎる、schedule 探索・JIT が実行利益を上回る、デバッグ時契約と実行時融合の意味が一致しないこと。

#### 提案する測定計画

1. **workload 行列を作る。** 総ノード数を `10^3/10^4/10^5/10^6/10^7`、独立単位を `1/16/256/4096`、依存の深さを `4/32/256/2048` として、実現可能な組合せだけを使う。幅と深さを独立に変える。同じ総ノード数でも「大きい関数1個」「小さい関数多数」を分ける。合成入力に加え、実リポジトリ full build と、変更が1定義に閉じる/広がる編集 trace を保存する。
2. **比較を公平にする。** pointer/tree CPU、flat IR 単一CPU、flat IR SIMD/全CPU、同IR GPU、固定閾値 hybrid、履歴モデル hybrid を比較。さらに CPU に適した走査削減・融合を認めた最良実装も入れる。各々で end-to-end と中核だけを分け、同じ受理/拒否・名前解決・診断位置を照合する。
3. **小さい論理パスと物理粒度を独立に変える。** 意味は同じまま、論理パス `1/4/16/64`、可能な範囲で物理 launch 数と host 待機数を変える。IR bytes read/written、materialized temporary bytes、global barrier、command buffer、CPU 待機、peak memory を記録する。「nanopass 化」の利益と「融合」の利益を混ぜない。
4. **cold/warm と一度/反復を分ける。** shader/library/PSO 作成、cache、IR 準備、submit、GPU 実行、結果の host 可視化、診断整形を別計測。warm 実行だけの勝利を短命CLI の勝利としない。30回程度から分布を取り、中央値とp95、分散・外れ値の扱いを固定する。入力順を無作為化し、モデル学習用と評価用のプロジェクトを分離する。
5. **配置仮説を反証する。** 入力サイズだけのモデルと、`N,W,D,temporary bytes` を加えたモデルを未知入力で比較。単独CPU/GPUだけでなく、CPU負荷・GPU負荷のある時も評価する。共有メモリでは両者の同時実行による帯域競合が利益を消す可能性を測り、scheduler の単体予測時間だけで良し悪しを判断しない。
6. **事前に採否の物差しを決める。** 期待倍率を置かず、`hybrid end-to-end < best CPU end-to-end` がどの入力領域で成立するか、モデル選択の損失 `T(chosen)-min(T(CPU),T(GPU))`、小編集p95、メモリ上限を報告する。GPU 利用率・TFLOPS は原因分析の指標とし、ユーザーが待つ時間の代替にしない。

### Gaps

- 実験は未実装・未実行。上記の入力サイズや回数は実験設計の提案であり、達成値ではない。
- Metal の所有権・共有メモリ可視性・event/command buffer の具体的契約は別担当の Apple 公式資料調査と突き合わせる必要がある。本ノートは先行研究の比較を担当し、それら API の細則を推測で補わない。
- Bend 固有の checker のどの段階が幅を持ち、どの段階に依存的正規化・共有状態が集中するかは、実装の計測と照合しないと決められない。
