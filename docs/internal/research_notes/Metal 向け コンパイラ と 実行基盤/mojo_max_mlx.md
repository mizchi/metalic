# Mojo/MAX・MLX と Metal 前提のコンパイラ実行基盤

## 1. 2026-11-15 時点で、何を既存機能と見なせるか

### Takeaway
安定版の基準は Mojo 1.2.0、MAX 26.7、MLX 0.32.4 とする。Mojo/MAX はすでに Apple GPU をターゲットにできるが、MAX のモデル実行対応は NVIDIA/AMD と同じ完成度ではない。[Mojo releases](https://mojolang.org/releases/)、[MAX 26.7](https://max.modular.com/releases/v26.7/)、[MLX 0.32.4](https://github.com/ml-explore/mlx/releases/tag/v0.32.4)、[MAX system requirements](https://max.modular.com/system-requirements/)

### Cited Findings
- Mojo 1.2.0 と MAX 26.7 は 2026-10-22 公開。Mojo 1.1.0/MAX 26.6 は 2026-09-17。nightly を安定版の能力に混ぜない。[Mojo releases](https://mojolang.org/releases/)、[MAX 26.7](https://max.modular.com/releases/v26.7/)、[MAX 26.6](https://max.modular.com/releases/v26.6/)
- MLX 0.32.4 は公式 GitHub API で `published_at=2026-10-14T23:37:14Z`。本ノートの MLX 実装検査は `v0.32.4` タグに固定した。[release](https://github.com/ml-explore/mlx/releases/tag/v0.32.4)、[release metadata](https://api.github.com/repos/ml-explore/mlx/releases/tags/v0.32.4)
- Mojo/MAX の GPU プログラミング互換表は Apple M1–M5、通常ターゲット `apple-m1`–`apple-m5` と Metal 4 用の `*-metal4` を列挙する。必要環境は macOS 15+/Xcode 16+、Metal 4 ターゲットは macOS 26+。M1 では後続世代で動く一部カーネルが失敗することも明記される。[Hardware compatibility](https://max.modular.com/gpu/hardware-compatibility/)
- 「GPU をプログラムできる」と「MAX の任意モデルを実用的に実行できる」は別。公式要件は Apple GPU 対応を開発中、一部モデルが動作し、B200/MI355X と同じ CI カバレッジはないと説明する。[System requirements](https://max.modular.com/system-requirements/)

### Inferences
- Metal を対象にする共通言語・ランタイムをゼロから作る必要性は低下した。ただし比較対象は「Metal 未対応の Mojo」ではなく、この安定版の実際の API と対象カーネルである。[Hardware compatibility](https://max.modular.com/gpu/hardware-compatibility/)

### Gaps
- SDK の導入や実行は行っていない。互換表から特定の IR 処理の速度・全 API の Apple 対応までは判断できない。
- MAX の無版 URL と `/stable/`、`DeviceContext` と `DeviceContextBase` の説明に差がある。重要なメモリ契約は後述の `max/v26.7.0` ソースで照合した。将来日付のリリース情報は採用していない。

## 2. Mojo の所有権・借用と、非同期 GPU バッファの寿命はどこまでつながるか

### Takeaway
Mojo の値の所有権と排他的可変参照は、CPU/GPU 共通実装に有用な部品である。しかし、外部ホストメモリを GPU に渡す既存 API は origin を消去するため、「所有権のある言語なので in-flight GPU アクセスの寿命も静的に安全」とは言えない。[Ownership](https://mojolang.org/docs/manual/values/ownership/)、[26.7 固定ソース](https://github.com/modular/modular/blob/max/v26.7.0/max/mojo/max/gpu/host/device_context.mojo#L5102)

### Cited Findings
- 現行構文の引数は既定が不変参照、`mut` が可変参照、`var` が所有する値。`^` による移譲後は元変数が未初期化になる。可変参照の引数排他性を検査するが、register-passable な trivial 値はコピー渡しなのでこの制約の対象外。[Ownership](https://mojolang.org/docs/manual/values/ownership/)
- カーネル引数は `DevicePassable` を満たす必要があり、`device_type` はホスト型からデバイス型への表現変換を定義する。例えばホストの `DeviceBuffer` はデバイスでは `Pointer` として渡される。これはデータ表現と引数 ABI の仕組みであり、単に任意の所有オブジェクトが GPU に移動する仕組みではない。[GPU fundamentals](https://max.modular.com/gpu/fundamentals/)、[DevicePassable](https://mojolang.org/docs/std/builtin/device_passable/DevicePassable/)
- **決定的な寿命上の制約**: `wrap_host_memory()` はアクセス権を与えるが確保の所有権を取得しない。26.7 固定ソースは、戻り値が元の確保を生かし続けず、origin を消すこと、全 enqueue 済み transfer/kernel の間 owner を生かすことを明記する。buffer の破棄は release をキューに積むため、unmap 前に関係 context を同期する必要がある。[26.7 source, L5102–5146](https://github.com/modular/modular/blob/max/v26.7.0/max/mojo/max/gpu/host/device_context.mojo#L5102)、[stable API の同じ説明](https://max.modular.com/stable/api/mojo/max/gpu/host/device_context/DeviceContextBase/#wrap_host_memory)

### Inferences
- 研究対象になり得るのは一般的な所有権の再発明より、**アクセス権を task completion に接続する層**である。提案として、投入時に buffer owner/読み取り権/排他的書き込み権を task に預け、completion token の解決まで保持し、終了後に権利を返す。イベント依存と lifetime token を別々に手で管理する箇所を減らせる。既存 API の origin 消去がこの追加層の必要性を具体化している。[26.7 source](https://github.com/modular/modular/blob/max/v26.7.0/max/mojo/max/gpu/host/device_context.mojo#L5123)
- これは API 設計案であり、新規性の主張ではない。動的に保持する Future/参照カウントと、型で in-flight 状態を表す方式は比較が必要。CPU の `mut` 排他性だけから非同期カーネル間の race freedom を導かない。[Ownership](https://mojolang.org/docs/manual/values/ownership/)

### Gaps
- Mojo の安全な通常バッファ API 全体について、非同期実行・複数キュー・任意のポインタ alias を含む形式的安全性定理は今回確認できていない。特に外部確保のラップは、公式に呼び出し側へ寿命責任が残る。

## 3. 共通 CPU/GPU ソース、MLIR、特殊化は何を提供するか

### Takeaway
Mojo では計算本体を共通化し、CPU/GPU の実行方法をコンパイル時に分けられる。MLIR を使って GPU コードを生成することと、パーサー・型検査器・最適化器そのものを GPU 上で実行することは別である。[Custom ops](https://max.modular.com/develop/build-custom-ops/)、[Inline MLIR](https://mojolang.org/docs/reference/inline-mlir/)

### Cited Findings
- 現行 custom-op チュートリアルの `elementwise()` は `ctx` のターゲットに対してコンパイル時に特殊化し、同じ計算を CPU/GPU に使う。必要なら `comptime if ctx.target.is_cpu()/is_gpu()` と別実装を用意し、thread/block・メモリ配置を制御する。Python 側で op の `device` を指定する。[Custom ops](https://max.modular.com/develop/build-custom-ops/)
- Mojo は MLIR ベースで、`__mlir_type`、`__mlir_attr`、`__mlir_op`、`__mlir_region` により言語に露出していない intrinsic や dialect operation を直接書ける。これは既存の IR operation を発行する escape hatch である。[Inline MLIR](https://mojolang.org/docs/reference/inline-mlir/)
- Mojo 1.2.0 は多数の math 関数を system libm 依存から共通 Mojo 実装に変更し、CPU/GPU で共有した実例を報告する。同時に数値差・subnormal・Apple GPU の `float64` 非対応も明記する。[Mojo 1.2.0](https://mojolang.org/releases/v1.2.0/)

### Inferences
- フラット IR の tag/operand/index 配列を受ける走査・map・compact 用カーネルは Mojo の直接 GPU API で記述する候補になる。再帰的な AST オブジェクトをそのまま GPU に送るのではなく、`DevicePassable` な view とデバイス表現を設計する必要がある。[GPU fundamentals](https://max.modular.com/gpu/fundamentals/)
- 「Mojo コンパイラが Metal を出力できる」は既存能力。「その compiler pass が GPU カーネルとして処理する」は追加プログラムの実装・データ構造・アルゴリズムの問題。MLIR の採用自体は後者の証拠にならない。[Inline MLIR](https://mojolang.org/docs/reference/inline-mlir/)

### Gaps
- 任意の新 MLIR dialect と lowering pass を外部プラグインとして安定的に追加できることは、inline MLIR だけでは確認できない。新 op の登録・検証・変換を足す経路と、既存 op を inline で呼ぶ経路を混同しない。
- 同じソースが CPU/GPU で最適な並列粒度・レイアウトになる保証はない。共通化率と backend 別コード量は実測対象。

## 4. MAX の graph fusion・メモリ計画・非同期化はどこまで一般化できるか

### Takeaway
MAX は単なるカーネル起動ラッパーではなく、複数 IR の lowering、fusion、メモリ計画、非同期実行を持つ。ただし一般の不規則 IR pass を tensor op に包むだけで、意味を理解した融合まで得られるわけではない。[Runtime errors](https://max.modular.com/develop/debugging-errors/)、[Custom ops](https://max.modular.com/develop/build-custom-ops/)

### Cited Findings
- 2025 LLVM Developers' Meeting の Modular 発表では、入力は MLIR の DL-op DAG と packaged kernels、出力は executable-kernel DAG。RMO/MO → MOGG（fusion、destination-passing）→ MGP（runtime primitives、メモリ計画、sequence fusion）→ JIT を説明する。これは **2025 時点の内部構造説明**。[Feras Boulala, MAX's JIT Graph Compiler, pp. 8–11](https://llvm.org/devmtg/2025-10/slides/technical_talks/boulala.pdf)
- 同発表は custom op と opaque Mojo 型を graph compiler が扱う escape hatch を示す一方、通常 custom kernel の内部意味は compiler に不透明と説明する。副作用は chain/buffer を使ってモデル化する。[同発表 pp. 21–22, 26–28](https://llvm.org/devmtg/2025-10/slides/technical_talks/boulala.pdf)
- 現行チュートリアルでは静的 `elementwise()` を定義した custom op は周囲の elementwise chain や matmul epilogue と融合できる。一般の `execute()` は独立カーネルとして起動されるため、任意の pass 列が自動的に単一走査へ融合するとは言えない。[Custom ops](https://max.modular.com/develop/build-custom-ops/)
- 現行 debug guide は各 lowering 段階で fusion、memory planning、device placement を行い、`MODULAR_DEBUG=ir-output-dir=...` で段階別 IR を保存できると説明する。GPU dispatch は通常非同期で、host が各 kernel の完了を待たずに enqueue する。[Runtime errors](https://max.modular.com/develop/debugging-errors/)、[GPU errors](https://max.modular.com/develop/debugging-gpu/)

### Inferences
- 論理 nanopass の分離と物理的なバッチ・融合は両立する。MAX から借りるべき点は、意味のある中間表現、fusion に opt-in できるカーネル契約、buffer/effect 依存、実行前のメモリ計画。実際に不規則 IR を融合するには、read/write set・依存・length 変化などの専用契約を与える必要がある。[MAX's JIT Graph Compiler](https://llvm.org/devmtg/2025-10/slides/technical_talks/boulala.pdf)
- tensor graph に寄せるルート、一般 custom op を粗く使うルート、Mojo の低レベル API だけ使うルートを分けると、既存最適化の利益と制約を比較しやすい。[Custom ops](https://max.modular.com/develop/build-custom-ops/)

### Gaps
- 2025 発表の dialect 名・opaque 型・内部拡張 API が 26.7 でそのまま安定しているとは断定しない。公開 API の現行確認が必要。
- MAX 内部の全メモリ再利用アルゴリズム、一般 task graph 全体の schedule cost、非テンソル pass への fusion 条件を記述した安定仕様は今回確認できていない。

## 5. デバイス選択・cost model・autotuning・オンライン適応をどう区別するか

### Takeaway
MAX には cost model やオンライン適応の実装が存在するので、「MAX はすべて静的で cost model がない」という主張は誤りになる。しかし、確認できた機能は tensor の mesh 上の再配置、GPU 内 scheduling、特定の推論処理などであり、任意の compiler pass を CPU/GPU に自動配分する能力とは区別が必要。[Sharding](https://max.modular.com/api/python/experimental.sharding/)、[TargetCostModel](https://max.modular.com/api/mojo/pipeline/types/TargetCostModel/)、[MAX 26.7](https://max.modular.com/releases/v26.7/)

### Cited Findings
- custom-op 例は `accelerator_count()` によって GPU がなければ CPU を選ぶ。これと、`ctx.target`・shape に対するコンパイル時特殊化は既存機能。前者は可用性判断、後者は選択済みターゲットへの codegen であり、実測された処理速度による offload 判断ではない。[Custom ops](https://max.modular.com/develop/build-custom-ops/)
- Brad Larson の **2026-02-03、MAX 26.1 時点の説明**は、graph compiler が target/shape を Mojo に渡し、明示的 parameterization とハードウェア・shape ごとの事前 autotuning を中心にするというもの。本人が留保している発言であり、現在の全機能を否定する根拠に使わない。[公式 forum #9](https://forum.modular.com/t/max-26-1-eager-to-compile-contract-lowering-pipeline-kernel-selection-across-gpus-and-extension-points-for-custom-ops/2677/9)
- 現行 `max.experimental.sharding` は op ごとに placement 候補を cost model で採点し、dispatch 時に最安の redistribution を選ぶ。whole-graph trace は行わないと明記する。対象は `Replicated/Sharded/Partial/Unknown` と device mesh 上の tensor 配置である。[Sharding](https://max.modular.com/api/python/experimental.sharding/)
- `pipeline.types.TargetCostModel` は GPU kernel の論理 op tag を resource kind・latency・role に写像し、schedule 制約を与える。host/device の汎用配置器を意味する名前ではない。[TargetCostModel](https://max.modular.com/api/mojo/pipeline/types/TargetCostModel/)
- 26.7 は speculative decoding で、測定した decode throughput に基づき verify 幅を動的に選ぶ機能も説明する。このような特定領域のオンライン適応があるため、「一切オンライン適応しない」とも言えない。[MAX 26.7 highlights](https://max.modular.com/releases/v26.7/)

### Inferences
- 未解決として切り出すなら、「不規則 IR の入力量・依存深度・live set・起動負荷・直前の実測を使い、複数 pass の **領域単位** で CPU/GPU を選ぶ方策」と定義すべきである。単に自動配置や cost model と呼ぶだけでは既存機能との差分が曖昧になる。[Sharding](https://max.modular.com/api/python/experimental.sharding/)
- per-op 貪欲選択は局所的な安さを選べても、隣接 pass の GPU 常駐、fusion、キュー起動の共用、共有メモリの競合をまとめて最適化した証拠にはならない。提案として、GPU 常駐領域を基本単位にして境界だけで CPU へ戻す方策と比較する。[Sharding の local/whole-graph 非採用という契約](https://max.modular.com/api/python/experimental.sharding/)
- graph の JIT は「アプリ全体の実行前」という意味では runtime に起こり得るが、生成されるカーネルに対して target/shape が compile-time 定数になることと矛盾しない。JIT 特殊化、事前チューニング、実行中の適応を三つに分けて記述する。[MAX's JIT Graph Compiler](https://llvm.org/devmtg/2025-10/slides/technical_talks/boulala.pdf)、[公式 forum](https://forum.modular.com/t/max-26-1-eager-to-compile-contract-lowering-pipeline-kernel-selection-across-gpus-and-extension-points-for-custom-ops/2677/9)

### Gaps
- 今回確認した公開資料では、任意の非テンソル compiler pass DAG に対する汎用の実測ベース CPU/GPU 配置は確認できない。「存在しない」と断定する調査結果ではない。
- device placement lowering があることだけでは、その選択基準が performance cost か、ユーザー指定・対応可否・fallback かは決まらない。

## 6. 統合メモリと Metal のキュー・イベントは何を省き、何を残すか

### Takeaway
Mojo/MAX には Apple の共有メモリを使う部品と非同期依存の部品がある。しかし同じ物理メモリを使うこと、ホストから読めること、キャッシュ効率が良いこと、アクセスしてよい時点はそれぞれ別の条件である。[MAX 26.6](https://max.modular.com/releases/v26.6/)、[MAX 26.7](https://max.modular.com/releases/v26.7/)

### Cited Findings
- 26.6 の `Device.is_host_unified` / `DeviceContext.is_host_unified()` は物理 pool の共有という topology を返し、任意 buffer の host readability を保証しない。`unsafe_host_ptr()` は Apple silicon で同期後にコピーなしの CPU 読み出しを可能にするが、読み出しは非キャッシュで、小さな control record 向きと明記される。[26.6 unified-memory APIs](https://max.modular.com/releases/v26.6/)
- 26.6 は Apple の `DeviceEvent` を `MTLSharedEvent` で実装し、実 GPU 完了を追跡すること、別 context のイベント待ちで host thread を止めないことを報告する。26.7 は Apple stream ごとに新しい Metal command queue を作り、event record/wait を CUDA/HIP と同じ形にする。[26.6](https://max.modular.com/releases/v26.6/)、[26.7](https://max.modular.com/releases/v26.7/)
- 26.7 の `wrap_host_memory()` は CUDA/HIP/Metal に対応するが、Metal はページ境界に揃えた base とページ倍数の長さを要求する。アクセスには返された buffer を使い、元 host pointer と同一デバイスアドレスだと仮定しない。[26.7](https://max.modular.com/releases/v26.7/)、[26.7 source](https://github.com/modular/modular/blob/max/v26.7.0/max/mojo/max/gpu/host/device_context.mojo#L5102)

### Inferences
- bulk IR を毎段 CPU から確認する設計は `unsafe_host_ptr()` の存在だけでは正当化できない。GPU stage 間は shared buffer とイベント依存で接続し、CPU には小さな完了・エラー・統計だけを返す設計を比較対象にする。[26.6](https://max.modular.com/releases/v26.6/)
- UMA でも queue submission、CPU/GPU 排他、cache/coherence、同期のコストは消えない。コピー byte 数だけで配置を評価せず、領域全体の wall-clock と host stall を観測する必要がある。[26.6](https://max.modular.com/releases/v26.6/)、[GPU async dispatch](https://max.modular.com/develop/debugging-gpu/)

### Gaps
- 具体的な Apple 世代での cache policy、bulk host access の帯域、CPU/GPU 同時アクセス時の競合は未測定。API 文書の「非キャッシュ」を全 allocator/全 buffer の属性へ一般化しない。

## 7. MLX はすでに何を実装しているか

### Takeaway
MLX は、共通メモリ上の配列、lazy graph、CPU/GPU ストリーム間依存、自動 fusion の直接の参照実装になる。一方、0.32.4 の標準デバイス選択は GPU の可用性とユーザーの stream 指定によるもので、演算量を予測して CPU/GPU を自動選択する説明ではない。[Unified memory](https://ml-explore.github.io/mlx/build/html/usage/unified_memory.html)、[0.32.4 device.cpp](https://github.com/ml-explore/mlx/blob/v0.32.4/mlx/device.cpp#L11)

### Cited Findings
- MLX の array は unified memory にあり、array 自体をデバイスへ移す代わりに演算へ `stream=mx.cpu` / `mx.gpu` を渡す。CPU 演算の結果に GPU 演算が依存すると scheduler が stream 間依存を挿入する。公式の M1 Max 例は、dense matmul を GPU、小さい連続 exp を CPU に **利用者が配置** すると速くなる例である。掲載時間はこの例の値で、他の処理の性能証拠ではない。[Unified memory](https://ml-explore.github.io/mlx/build/html/usage/unified_memory.html)
- stream 未指定なら default device の default stream。0.32.4 の初期 default device は `gpu::is_available() ? gpu : cpu`。custom C++ Primitive もユーザーが指定した stream/device に応じて `eval_cpu` / `eval_gpu` を呼ぶ。[Using streams source](https://github.com/ml-explore/mlx/blob/v0.32.4/docs/src/usage/using_streams.rst#L11)、[device.cpp](https://github.com/ml-explore/mlx/blob/v0.32.4/mlx/device.cpp#L11)、[Extensions](https://ml-explore.github.io/mlx/build/html/dev/extensions.html)
- 実装では graph 評価時に producer/consumer の stream 相違を調べ、device switch を記録し、fence/event の wait を入れる。CPU stream は scheduler の task queue へ投入される。Metal allocator は `ResourceStorageModeShared` と untracked hazard mode を使うため、依存追跡を runtime が引き受けることを確認できる。[transforms.cpp](https://github.com/ml-explore/mlx/blob/v0.32.4/mlx/transforms.cpp#L150)、[scheduler.cpp](https://github.com/ml-explore/mlx/blob/v0.32.4/mlx/scheduler.cpp#L101)、[allocator.cpp](https://github.com/ml-explore/mlx/blob/v0.32.4/mlx/backend/metal/allocator.cpp#L15)
- `mx.compile` は graph を trace し、共通処理をまとめ、対応 op を fusion してコードを生成・キャッシュする。shape/type/引数数の変更は再コンパイル要因。`shapeless=True` は shape 変化による再コンパイルを避けるが、shape 依存 Python 処理には制約がある。compiled function は pure であることを期待する。[Compilation](https://ml-explore.github.io/mlx/build/html/usage/compile.html)
- 0.32.4 の fusion は stream の違い・深さ制限等で停止する。compile cache も default stream/device を照合する。このコード経路は既存 placement を尊重する形であり、CPU/GPU をまたぐ cost-based 配置最適化の証拠にはならない。[compile.cpp](https://github.com/ml-explore/mlx/blob/v0.32.4/mlx/compile.cpp#L370)、[fusion 停止条件](https://github.com/ml-explore/mlx/blob/v0.32.4/mlx/compile.cpp#L850)
- Python/C++ の custom Metal kernel は任意の MSL 本体・grid/threadgroup・出力 shape/dtype を指定でき、atomic output にも対応する。カーネル作成時は library/JIT の費用があるため再利用を推奨する。`ensure_row_contiguous=True` が既定で、必要なら入力のコピーが起こる。[Custom Metal kernels](https://ml-explore.github.io/mlx/build/html/dev/custom_metal_kernels.html)
- 配列の `item()`、print、NumPy 化、scalar array による Python 分岐は評価を起こす。一段ずつ `eval` すると評価単位ごとの固定費が問題になる。[Lazy evaluation](https://ml-explore.github.io/mlx/build/html/usage/lazy_evaluation.html)

### Inferences
- MLX は task dependency と shared allocator を再利用し、不規則処理を custom primitive/MSL kernel に入れる現実的な評価台になる。ただし CPU/GPU 共通計算本体を保証する言語ではなく、custom extension 例は CPU と GPU の実装を別々に提供する。[Extensions](https://ml-explore.github.io/mlx/build/html/dev/extensions.html)
- 「MLX が必要な stream 間依存を自動管理する」は既存。「MLX が compiler pass を性能予測で自動配置する」は確認できない。GPU 不在時に CPU が default になる fallback を性能判断と呼ばない。[device.cpp](https://github.com/ml-explore/mlx/blob/v0.32.4/mlx/device.cpp#L11)、[Using streams](https://ml-explore.github.io/mlx/build/html/usage/using_streams.html)

### Gaps
- 0.32.4 の lazy-evaluation 文書には「まだ graph の compile/rerun をしない」という古い段落が残るが、同版の Compilation 文書・`compile.cpp` と矛盾する。lazy の一般的動作だけに依拠し、compile 非対応の証拠としては使わない。[lazy 文書 source L25](https://github.com/ml-explore/mlx/blob/v0.32.4/docs/src/usage/lazy_evaluation.rst#L25)、[compile source](https://github.com/ml-explore/mlx/blob/v0.32.4/mlx/compile.cpp)
- 任意の custom Metal kernel 内部を `mx.compile` が理解して隣接 kernel と融合する保証は確認できない。custom kernel を一つ作れることと、compiler pass 列を自動融合することは分ける。

## 8. フラット IR、GPU 内 logical length、領域単位配置に残る設計課題は何か

### Takeaway
実装上の焦点は、tensor の「出力 shape」と compiler IR の「確保容量・有効件数」を分離できるか、task の完了まで buffer owner とアクセス権を保持できるか、配置判断が host readback を誘発しないかにある。以下は既存 API から導く設計提案であり、実装済み機能や新規性の断定ではない。[MAX 26.7](https://max.modular.com/releases/v26.7/)、[26.7 memory contract](https://github.com/modular/modular/blob/max/v26.7.0/max/mojo/max/gpu/host/device_context.mojo#L5123)、[MLX custom kernels](https://ml-explore.github.io/mlx/build/html/dev/custom_metal_kernels.html)

### Cited Findings
- MAX 26.7 の `nonzero` は GPU 上で安定順の出力を生成するが、行数が data-dependent なので件数を host で計算する。`tile` の data-dependent output size は device-graph capture を妨げる。したがって標準 tensor op の shape 契約が GPU 常駐の障壁になる具体例がある。[MAX 26.7 GPU graph/eager ops](https://max.modular.com/releases/v26.7/)
- MLX custom kernel の呼び出しでは `output_shapes` と `output_dtypes` を host 側で渡す。C++ Primitive の評価実装は出力確保を自分で行う責任がある。[Custom Metal kernels](https://ml-explore.github.io/mlx/build/html/dev/custom_metal_kernels.html)、[Extensions](https://ml-explore.github.io/mlx/build/html/dev/extensions.html)

### Inferences
- **容量と件数の分離案**: tag/operand/offset などの SoA を capacity `C` で確保し、GPU 内の有効件数 `n≤C` を別の control buffer に置く。後続 pass は capacity shape のまま counter を読んで処理する。これなら毎段の exact `n` を tensor shape にする必要を減らせる。出力が上界を超える場合の overflow flag と増設・再実行方針は別途必要。[標準 nonzero の shape 境界との対比](https://max.modular.com/releases/v26.7/)
- **data-dependent なら必ず同期、ではない**: kernel 内で count を参照し、上界 grid を起動して guard する方式、GPU counter から後続の indirect dispatch 引数を生成する方式が設計候補。後者は対象 backend が indirect command を公開・合成できるか追加確認が必要で、本調査では Mojo/MAX/MLX の安定 API による実現まで確認していない。[出力 shape を host が渡す現行 MLX 契約](https://ml-explore.github.io/mlx/build/html/dev/custom_metal_kernels.html)
- **配置のための readback の条件**: 入力ファイルサイズ、既知 capacity、host で既知の shape はコピーせず配置判断へ使える。一方、GPU pass が作った exact live count・分岐密度・worklist 長を host scheduler が次の配置条件として要求すると、その値が利用可能になるまでの GPU→host 依存が必要になる。UMA はこの依存を消さない。上界・前回値・遅延統計・device-side 継続判断による回避を比較する。[MAX topology/readability の区別](https://max.modular.com/releases/v26.6/)、[MLX scalar 評価](https://ml-explore.github.io/mlx/build/html/usage/lazy_evaluation.html)
- **領域単位配置案**: `GPU map→scan→compact→rewrite` のような連続領域を一単位として residency を維持し、host が必要な診断生成や serial frontier でだけ境界を設ける。op ごとの配置は、個々の実行時間だけでなく領域を切る固定費・イベント・メモリアクセス競合・fusion の損失まで評価する必要がある。これは mesh redistribution の局所 cost model とは対象が違う。[MAX per-op local model](https://max.modular.com/api/python/experimental.sharding/)、[MLX stream 境界の fusion 制約](https://github.com/ml-explore/mlx/blob/v0.32.4/mlx/compile.cpp#L850)
- **非同期 ownership 案**: region/task へ buffer access lease を渡し、completion が owner を保持する。read-after-write、write-after-read、write-after-write の辺から event を構築し、最後の利用完了で再利用可能にする。CPU が同じ shared buffer を触る場合も lease を取得する。raw pointer escape と外部 buffer は明示的な unsafe 境界へ寄せる。[wrap の origin 消去・寿命契約](https://github.com/modular/modular/blob/max/v26.7.0/max/mojo/max/gpu/host/device_context.mojo#L5123)、[MLX の実行依存追跡](https://github.com/ml-explore/mlx/blob/v0.32.4/mlx/transforms.cpp#L150)

### Gaps
- 上界起動の無駄と exact count readback の費用、indirect dispatch の実現性、動的容量増設、opaque/custom op による細かな effect 表現は未検証。全 compiler pass が flat map に変換できるとも主張しない。
- parser・依存型検査・unification・名前解決の可変長・不規則依存を tensor 型へ自然に表せるかは、実際の IR とアルゴリズムを選ばないと判定できない。

## 9. bespoke Metal runtime と区別する最小の実験は何か

### Takeaway
次段階の比較は、同じ flat IR と同じ意味の CPU/GPU カーネルを使い、直接 Metal、Mojo 低レベル API、MAX graph custom ops、MLX custom primitives の「runtime の差」を測る形にする。この段階では実装・SDK 導入・速度測定は行っていない。

### Cited Findings
- MAX は lowering IR dump を提供し、MLX は公開ソースで fusion 境界と event/fence を検査できる。カーネル時間だけでなく生成 graph と実行依存を観測できる比較材料がある。[MAX debug IR](https://max.modular.com/develop/debugging-errors/)、[MLX fusion](https://github.com/ml-explore/mlx/blob/v0.32.4/mlx/compile.cpp#L800)、[MLX dependency](https://github.com/ml-explore/mlx/blob/v0.32.4/mlx/transforms.cpp#L150)

### Inferences
- **対象処理の提案**: (a) 独立 tag/operand rewrite、(b) scan/compact を含む可変長変換、(c) 数段の依存伝播/worklist 更新。入力件数だけでなく frontier 幅と依存深度も変える。GPU 対象コードを生成するだけの計測にせず、pass 自体が GPU で IR 配列を処理するものを選ぶ。[Mojo の kernel 実行モデル](https://max.modular.com/gpu/fundamentals/)
- **比較条件の提案**: CPU 常駐、GPU 常駐、各 pass で count を host に戻す方式、capacity＋GPU count を維持する方式を比較する。配置はまず手動の最良選択を基準にし、per-op 貪欲と region 単位の自動配置がどこまで近づくか調べる。[MLX の明示配置例](https://ml-explore.github.io/mlx/build/html/usage/unified_memory.html)、[MAX local placement](https://max.modular.com/api/python/experimental.sharding/)
- **観測量の提案**: end-to-end latency、初回 compile/JIT と warm 実行、kernel/queue 提出数、host wait、readback/control-record 回数、確保量と再利用、実際に融合した pass、CPU/GPU 並行時の競合。MLX の contiguous 化や shape 変更の再 compile を含め、隠れたコピー・初期化費用を分ける。[MLX compile](https://ml-explore.github.io/mlx/build/html/usage/compile.html)、[MLX custom kernel](https://ml-explore.github.io/mlx/build/html/dev/custom_metal_kernels.html)
- **判別基準の提案**: Mojo が同等の queue/event/buffer 制御を出せるなら bespoke runtime の価値は MSL 回避より ownership/IR/placement に移る。MAX/MLX で count/shape の境界を消せず同期が残るなら、tensor API を迂回する粗い custom op/低レベル runtime が必要。どちらも実験前の仮説である。[Mojo/MAX Apple events](https://max.modular.com/releases/v26.6/)、[MAX dynamic output](https://max.modular.com/releases/v26.7/)

### Gaps
- 数値結果は未取得。どの実行基盤が速いか、どの入力規模から GPU が得か、CPU/GPU 同時実行が得かは本調査だけでは決められない。
