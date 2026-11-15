# Apple Silicon と Metal の実行基盤最適化

調査日: 2026-11-15。公開一次資料・実装とローカルの M5 を確認した。Context7 は quota exceeded で利用できず、Apple の公式 Markdown、MSL 仕様、著者 artifact を直接確認した。

## 追加確認 MSL 4.1 を明示指定した検査

v2 の対象は最新 MSL 4.1 とする。Apple の `MTLLanguageVersion.version4_1` は macOS 27以降の API。Xcode 27は macOS 26.6以降で起動できるが、4.1の実行要件と Xcode の起動要件は別である。— [MSL 4.1 availability](https://developer.apple.com/documentation/metal/mtllanguageversion/version4_1)、[Xcode の要件](https://developer.apple.com/xcode/system-requirements)

当初の4.0指定の構文 probe に加え、4.1のバージョン値を `MTLCompileOptions.languageVersion` に明示し、shader 側でも `__METAL_VERSION__ == 410` を要求する検査を実行した。[保存した probe](probes/msl41.mm)は古い SDK の enum 値の符号化を使う検査専用で、v2 本体では新 SDK の `MTLLanguageVersion4_1` を使う。

```text
host: macOS 26.6.2 / Xcode 26.4 / macOS SDK 26.4 / Apple M5
compiler: Apple metal version 32023.883 (metalfe-32023.883)
device=Apple M5 requested=MSL4.1 result=unsupported
error: invalid value 'metal4.1' in '-std=metal4.1'
```

現環境の runtime compiler が4.1を拒否することを確認した結果であり、M5のハードウェア上限を示す結果ではない。4.1の実行・メモリ順序の検証は macOS／SDK 更新後に行う。言語バージョン未指定時は最新を使うという Apple の説明があるが、v2 は再現性と要件検査のため4.1を明示する。— [languageVersion](https://developer.apple.com/documentation/metal/mtlcompileoptions/languageversion)

## 最新 Metal で GPU 主導の発行と資源再利用は何ができるか

### Takeaway

GPU count による間接 dispatch は Metal 4 を待たず現 API で導入できる。Metal 4 は command buffer／allocator の再利用を明示的に提供するが、記録済みグラフの無条件 replay と同義ではなく、資源保持・同期の責任も変わる。

### Cited Findings

- 旧 `MTLComputeCommandEncoder.dispatchThreadgroups(indirectBuffer:indirectBufferOffset:threadsPerThreadgroup:)` は macOS 10.11 / iOS 9 以来。GPU が先行 compute で引数を作り、後続間接 dispatch がそれを消費できるため、中間 count の CPU 読み取りは不要。— [API と availability](https://developer.apple.com/documentation/metal/mtlcomputecommandencoder/dispatchthreadgroups(indirectbuffer:indirectbufferoffset:threadsperthreadgroup:).md)、[Apple の GPU 生成引数の説明](https://developer.apple.com/documentation/metal/specifying-drawing-and-dispatch-arguments-indirectly.md)
- `MTLIndirectCommandBuffer` は CPU または GPU が記録する再利用可能な command の集合。単なる grid size の間接指定と、pipeline や命令列を保持する ICB を区別する。— [MTLIndirectCommandBuffer](https://developer.apple.com/documentation/metal/mtlindirectcommandbuffer.md)
- Metal 4 の `MTL4CommandBuffer` と compute encoder は macOS 26 以来。Apple Silicon Mac で Metal 4 を利用できる。新 API は command buffer を device から生成し、queue に submit し、再度 begin して新しい命令を記録できる。— [MTL4CommandBuffer](https://developer.apple.com/documentation/metal/mtl4commandbuffer.md)、[Metal 4 core API](https://developer.apple.com/documentation/metal/understanding-the-metal-4-core-api.md)、[Apple の対応機種表](https://support.apple.com/en-ie/102894)
- Metal 4 の command buffer は旧 API の標準設定と違い資源への strong reference を作らない。allocator の `reset` はそこから割り当てた全 command buffer の完了後に限る。所有権を表現する submission/future は buffer だけでなく arena、allocator、pipeline、argument table も完了まで保持する必要がある。— [core API](https://developer.apple.com/documentation/metal/understanding-the-metal-4-core-api.md)、[allocator reset](https://developer.apple.com/documentation/metal/mtl4commandallocator/reset().md)
- Metal 4 の `dispatchThreads(indirectBuffer:)` は GPU address を受ける。旧 API の indirect dispatch でも今回の tokenCount/nodeCount による仕事量縮小は可能なので、最初の最適化を Metal 4 全移植と結び付ける必要はない。— [Metal 4 indirect dispatch](https://developer.apple.com/documentation/metal/mtl4computecommandencoder/dispatchthreads(indirectbuffer:).md)、[旧 API](https://developer.apple.com/documentation/metal/mtlcomputecommandencoder/dispatchthreadgroups(indirectbuffer:indirectbufferoffset:threadsperthreadgroup:).md)
- 別 queue の GPU work は `MTLEvent`、CPU を含む連携は `MTLSharedEvent` の値と notification で協調できる。Metal kernel 自体が host I/O thread を操作する設計ではない。— [同一 device の queue 間連携](https://developer.apple.com/documentation/metal/synchronizing-events-within-a-single-device.md)、[CPU/GPU event](https://developer.apple.com/documentation/metal/synchronizing-events-between-a-gpu-and-the-cpu.md)
- WWDC25 は MSL→Metal IR→GPU binary の compiler API を CPU 上の処理として説明している。GPU 上で frontend/IR を処理できても、公式 shader compilation API 自体が GPU kernel から直接呼べるという根拠はない。— [Discover Metal 4, 10:43 以降](https://developer.apple.com/videos/play/wwdc2025/205/)

### Inferences

- 推奨: host に長寿命の compiler service を置き、pipeline とサイズ別 arena pool を再利用し、`BatchId / Submission / Completion` を affine な所有者にする。小さなファイルを束ねて一つの GPU graph にする。現在の「1ソースごとに submit/wait」から離れることが launch 固定費への対策になる。これは上記 API からの設計提案で、今回のコードに実装済みではない。
- GPU で token/node count を生成した時点で indirect argument も併せて出力し、その後の node 単位パスを実件数で発行する。静的な pass DAG の各 kernel は host が予約したままでよい。ICB 全体の導入より変更が小さい。
- CPU と GPU の選択は個々の軽い nanopass のたびに戻すより、バッチ／関数群／まとまった subgraph の単位で選ぶ方が境界回数を抑えられる。切り替え閾値は native CPU baseline と実測から決める。

### Gaps

- Metal 4 に移せば今回の compiler の encode 時間が何 % 減るかは測定していない。通常の command buffer オブジェクト再利用と、記録済みの命令の replay を混同しない。
- GPU 内から無制限に任意の kernel を起動し、任意の host API を呼べる一般スケジューラの保証は確認していない。まず host が予約した有限 DAG と GPU 生成 count を前提にする。

## SIMD scan と単一 dispatch scan は Metal でどう使うべきか

### Takeaway

まず SIMD-group を使う階層 scan に置き換えるのが低リスク。その次に SPAA 2025 の Decoupled Fallback を評価する。単純な Decoupled Lookback の cross-threadgroup spin を Apple GPU へ移植してはいけない。

### Cited Findings

- SIMD-group の幅は pipeline の `threadExecutionWidth` で取得し、その倍数で threadgroup を構成することを Apple が推奨する。今回の M5 や論文の M1/M3 が32でも仕様上の固定値にはしない。— [Creating threads and threadgroups](https://developer.apple.com/documentation/metal/creating-threads-and-threadgroups)、[threadExecutionWidth](https://developer.apple.com/documentation/metal/mtlcomputepipelinestate/threadexecutionwidth)
- 2026-06-04版 MSL 仕様 Table 6.15 は `simd_prefix_inclusive_sum`, `simd_prefix_exclusive_sum`, `simd_sum`, `simd_min`, `simd_shuffle_up` を規定する。min-prefix や DFA 関数合成のような独自演算は shuffle による scan 等を別途構成し、sum intrinsic をそのまま適用しない。— [公式 MSL 仕様、§6.10.2、pp.220–222](https://developer.apple.com/metal/Metal-Shading-Language-Specification.pdf)
- 現行 `scan_blocks` は256要素の shared-memory Hillis–Steele。初回1回＋stride 8段×2回の threadgroup barrier、計17回を局所 scan ごとに実行している。global は group totals の再帰 scan と add。— [現行 frontend.metal:87](../../../../native/frontend.metal#L87)、[main.mm:133](../../../../native/main.mm#L133)
- **Thomas Smith, Raph Levien, John D. Owens, “Decoupled Fallback: A Portable Single-Pass GPU Scan,” SPAA 2025**, 公開日2025-07-16、会議2025-07-28〜08-01、DOI 10.1145/3694906.3743326。Apple M1 Max/M3 を含め、native Dawn/WebGPU の inclusive sum を評価。forward-progress guarantee が無い機器で、待たされた tile を他 workgroup が再計算することで starvation を回避する。— [論文](https://escholarship.org/content/qt0bk9z4bt/qt0bk9z4bt.pdf)
- 著者 artifact は **Dawn と CUDA**。README も通常 Lookback の `csdl` は FPG がなければ crash と警告する。native MSL 実装をそのまま利用できる artifact ではない。— [著者 artifact README](https://github.com/b0nes164/Decoupled-Fallback-Paper/blob/main/README.md)
- 同論文は、state と payload を複数の32-bit atomic に分割し、各部分の state が整合した時に読む方式を導入する。独立した `ready` flag と非 atomic payload を relaxed atomic だけでやり取りする一般的 producer/consumer 方式と同じではない。— [論文 §4.4、Figure 5](https://escholarship.org/content/qt0bk9z4bt/qt0bk9z4bt.pdf)
- 一般の GPUPrefixSums リポジトリは CUDA/D3D12/Unity/WGPU を列挙し、README は fallback の最新開発先として Vello を参照する。ただし最初の移植元には査読論文と対応 artifact の組を使う方が実験条件を追える。— [GPUPrefixSums](https://github.com/b0nes164/GPUPrefixSums)、[論文 artifact](https://github.com/b0nes164/Decoupled-Fallback-Paper)

### Inferences

- 段階1: 各 thread が複数要素を register で処理→SIMD scan→SIMD ごとの合計だけを threadgroup memory へ→少数の合計を scan→offset 加算。現在の17 barrier を減らせる設計だが、要素数・register pressure・occupancy の最適点は測定する。
- 段階2: single-pass fallback を u32 sum から実装。さらに minimum、負の括弧差分を含む modular u32 sum、非可換な DFA-summary composition へ拡張する時は、identity と合成順序、overflow、tile 再実行の冪等性を別に検証する。sum での性能実証を9状態の関数合成へ一般化しない。
- 「単一 dispatch なら速い」は仮説。今回の最大入力は1MiBで、論文の大規模帯域測定より小さい。小さい配列は局所 scan／階層 scan の方が有利な可能性がある。

### Gaps

- native MSL での Decoupled Fallback の速度・compiler lowering・M5 での starvation 回避を今回は実装／測定していない。Dawn での Apple 測定と直接 MSL での測定は区別する。
- M5 が任意の persistent kernel に十分な forward-progress を保証するという Apple 公式仕様は確認していない。新しいメモリ順序機能は scheduler progress の保証ではない。

## Metal の同期と UMA をどう設計へ反映するか

### Takeaway

UMA は copy を減らせるが、GPU 完了・可視性・資源寿命を解決しない。現在の旧 Metal encoder と Metal 4 は同期モデルが異なり、barrier を機械的に残す／削るのは不適切。

### Cited Findings

- Apple の公式 docs は旧 `MTLComputeCommandEncoder` の default pass を **serial**、`MTL4ComputeCommandEncoder` を **concurrent** と説明する。旧 API では device から生成した直接 binding の tracked resource は framework が access conflict を同期する。— [Resource synchronization](https://developer.apple.com/documentation/metal/resource-synchronization.md)
- Metal 4 は全 resource を untracked とし、競合する stage に explicit synchronization を要求する。最小範囲の barrier、pass間 fence、queue間 event、CPU間 shared event を選択する。— [core API の Barriers](https://developer.apple.com/documentation/metal/understanding-the-metal-4-core-api.md)、[同期の適用範囲](https://developer.apple.com/documentation/metal/resource-synchronization.md)
- Metal 4 の ICB execute command 自体は stage に属さず、ICB 全体を一つの stage とみなした barrier で完了待ちできない。内部 command は通常と同じ stage に属する。— [MTL4ComputeCommandEncoder の stage 表](https://developer.apple.com/documentation/metal/mtl4computecommandencoder.md)
- Apple GPU の `shared` は CPU/GPU の双方からアクセス可能、`private` は GPU のみからアクセス可能だが双方とも system memory 上。GPU 専用の中間資源には private が推奨される。memoryless は texture 専用であり compiler の汎用 buffer を tile memory にできる指定ではない。— [Choosing a resource storage mode](https://developer.apple.com/documentation/metal/choosing-a-resource-storage-mode-for-apple-gpus.md)
- 公式 MSL 仕様2026-06-04版は、Apple Silicon の device-scope `atomic_thread_fence` を Metal **3.2** 以来、acquire/release/acq_rel と通常 atomic の mem_flags overload を **4.1** 以来と記載する。従って2025論文の「古い Metal／WebGPU に memory barrier がない」という制約を最新全 Metal に一般化しない。— [MSL §6.16、pp.298–303](https://developer.apple.com/metal/Metal-Shading-Language-Specification.pdf)
- ローカル検証: `/tmp/metal-runtime-probe.mm` を clang++ でビルドし、Apple M5 の `newLibraryWithSource` を MSL4.0 指定で呼んだ。relaxed atomic は compile 成功、device-scope seq_cst atomic_thread_fence は compile 成功、4.1 形式 release atomic は `memory_order_release` undeclared で失敗した。ローカル SDK enum は4.0まで。これは **構文コンパイルの検証のみ**、GPU 実行・memory litmus・forward progress の検証ではない。— [仕様](https://developer.apple.com/metal/Metal-Shading-Language-Specification.pdf)、ローカル probe の結果（下記）

```text
device=Apple M5
test=0 lang=4.0 result=compiled     # relaxed atomic
test=1 lang=4.0 result=compiled     # seq_cst device fence
test=2 lang=4.0 result=failed       # release atomic, undeclared memory_order_release
```

### Inferences

- 現コードは default serial encoder、device 生成 shared/tracked buffers、直接 binding を使う。それでも dispatch ごとに `memoryBarrierWithScope:Buffers` を置いている。**旧 API のまま**余分な barrier の削減を試す根拠がある。Metal4 移植時には data dependency DAG に従って必要な dispatch→dispatch barrier を明示する。— [main.mm:117](../../../../native/main.mm#L117)、[main.mm:130](../../../../native/main.mm#L130)
- host と共有する ingress/egress、GPU resident の scratch/IR を別 buffer に分けると、private の比較と資源寿命管理が明確になる。private が system-memory buffer の scan を必ず高速化するとは断言しない。
- 新しい memory fence/atomic が使えても、全 workgroup をまたぐ実行 barrier や unfair scheduling の問題は別。persistent worklist は「先行 workgroup がいつか動く」という spin 依存を避け、有限 wavefront、helping、fallback、または dispatch 境界に分ける。

### Gaps

- MSL4.1 の該当節には追加機能の説明と、旧「通常 atomic は relaxed のみ」という文が併存する。今回のローカル4.0環境では4.1を検証できないため、4.1採用は SDK/language/device の feature probe と litmus test が必要。Metal.jl でも4.1/macOS27を区別しているが、wrapperの記載だけを Apple の availability 保証として扱わない。— [Metal.jl 実装](https://github.com/JuliaGPU/Metal.jl/blob/main/src/device/intrinsics/synchronization.jl)
- 現測定から「UMA readback が何 µs」「private は shared より何 % 速い」は答えられない。

## 現行試作で優先すべき実験は何か

### Takeaway

最大入力の149 dispatch のうち76回が診断 reduction に使われる。まずこの固定費と毎回の arena 確保・初期化を分離計測し、論理パスを保ったまま物理実行をまとめる。

### Cited Findings

- 現 native は毎回 `newBufferWithLength` で source/arena を確保し、arena 全体を `memset`、補助列を `fill` する。library と pipeline は Runtime 生成時に一度作成する。— [main.mm:59](../../../../native/main.mm#L59)、[main.mm:103](../../../../native/main.mm#L103)
- 77,713 byte の module は48,896 node、149 dispatch、arena 11,782,876 bytes。中央値は frontend1783.125µs、device624.375µs。最終 JSON 化と library/pipeline setup は frontend から除外される。— [計測 snapshot](../../../../measurements/apple-m5.json)
- `treeBase=nextPow2(n+1)=131072` の時、`diagnose` は seed1＋level17＋publish1=19 dispatch。operator 後、AST validation 後、resolution 後、type 後の4回で **76 dispatch**。これは149に対する**件数比**であって、処理時間の51%という測定ではない。— [diagnose, main.mm:144](../../../../native/main.mm#L144)、[呼出箇所](../../../../native/main.mm#L182)
- WWDC26 は Metal の長時間 trace、CPU/GPU utilization と contextual trace を説明し、`metalperftrace` を **macOS27 の新ツール**として紹介する。この試作機の macOS26.6.2 で利用可能とはしない。— [WWDC26 Find and fix performance issues in your Metal games](https://developer.apple.com/videos/play/wwdc2026/388/)
- WWDC26 の Metal guide の主要更新は量子化tensor、Neural Accelerators 等であり、それを整数の parser/scan の高速化と直接結び付ける根拠はない。— [WWDC26 Metal guide](https://developer.apple.com/wwdc26/guides/metal/)

### Inferences

実験の優先順と判定条件:

| 優先 | 変更案 | 比較と合格条件 |
|---|---|---|
| P0 | 時間を source encode、allocate、zero/fill、command encode、commit、wait、result read/JSON に分ける。GPU は pass区間timestamp/countersを採れる範囲で測る | process/library cold、warm latency、batch throughputを別記。native CPU と同じデータ・出力範囲で比較。中央値の差を readback 単独時間と呼ばない |
| P0 | 診断の tree reduction を threadgroup 最小値→最終 group reduction の2段程度へ変更 | byte offset/code の優先順位・EOF・204破壊ケースを維持。149 dispatch の構成と実時間の双方を記録 |
| P0 | 診断の代案: エラー時だけ packed key に `atomic_min` | 現上限1MiBとcode<=18なら `(offset << 5) | code` がu32に収まり NONE=0xffffffff と衝突しない。success path に global atomicを置かない。大量の不正文字による競合を2段reduceと比較 |
| P0 | source／arena pool、列の liveness による scratch 再利用、必要範囲だけ初期化 | completion まで再利用しない。空・不正入力・直前より短い入力で古い値が残らない。CPU zero/fill時間とarena bytesを計測 |
| P1 | tokenCount/nodeCount で indirect dispatch | dispatch自体の件数減とは区別。無効 thread数、GPU時間、引数生成costを記録。count0を正しく扱う |
| P1 | SIMD-group 階層scan、複数要素/thread | sum/min/DFA compositionの順序と境界を照合。小入力～1MiB・偏った長さ・複数batchで比較 |
| P1 | 旧serial/trackedで不要barrier削減、独立producerの融合 | data hazard契約とGPU validationを維持。Metal4は別実験として明示barrierを再設計 |
| P2 | Metal4 allocator/argument table導入、Decoupled Fallback移植 | P0/P1で残る費用を見て選ぶ。progress stress、oversubscription、scheduler妨害、32bit境界値で正しさを検証 |

診断キーは**段階ごと**に分け、grammar/AST validation→resolution→types の prior-stage validity を固定してから同一段階の全診断を行う。例えば duplicate declaration を発見した時点で同じ resolution 段階の未定義名チェックを中止すると、より早い byte のエラーを取りこぼす。型段階も同様。packed key の bit幅は入力上限・code ABI の変更時に静的に再検証する。

論理 Nanopass の型／契約と、物理 kernel／materialization の単位は別にする。複数の純粋 map 段階は一つの kernel へ、複数列の scan/reduction は tuple を使って共通化できる可能性がある。ただし非可換演算の順序、resource依存、error phase境界を保持する。これはコード生成・scheduler の設計提案で、実測済みの speedup ではない。

### Gaps

- 本調査では prototype を変更していない。ここで挙げた高速化はまだ性能結果を持たない。
- CPU oracleは TypeScript の正しさ参照で、GPU選択の閾値・CPU比speedup の根拠にはしない。
