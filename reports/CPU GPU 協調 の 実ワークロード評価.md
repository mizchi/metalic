# CPU GPU 協調 の 実ワークロード評価

**粗い純粋な GPU 領域と、外部状態の決定権を持つ CPU の組合せは有望である。条件は、CPU に戻る判断を要素ごとに置かず、region／batch／epoch ごとに集約できることだ。** CPU が持つ状態の量やコード量より、GPU の結果が次の計算を決める頻度と依存経路が重要になる。加えて GPU 領域自身に十分な並列幅があり、連続したデータ配置と中間結果の常駐を保てなければ、高速化は成立しない。

したがって Metalic では、「純粋なら GPU」より **snapshot → GPU 常駐の処理列 → 小さい summary／delta → CPU commit** を設計単位にするのがよい。全ビルドや snapshot ETL は候補になり、小さな増分編集や結果依存の細かい callback は CPU 完結も有力になる。これは現時点の設計判断であり、実用コンパイラ全体の速度向上を実証した結論ではない。

調査日: 2026-11-15。先の [実行基盤の調査](<Metal 向け コンパイラ と 実行基盤.md>)と [言語処理系の設計案](<Metal GPU 言語処理系 の 設計最適化.md>)を踏まえ、今回は協調の費用と実ワークロードに絞る。根拠の詳細は [費用モデル](<../research_notes/CPU GPU 協調 の 実ワークロード評価/cost_model.md>)、[ワークロード別検討](<../research_notes/CPU GPU 協調 の 実ワークロード評価/workloads.md>)、[形式化の境界](<../research_notes/CPU GPU 協調 の 実ワークロード評価/formal_boundaries.md>)に保存した。

## 純粋性とアフィン制約が保証するもの

純粋性は独立な計算を並べ替える根拠になり、アフィンな所有権は mutable alias と in-flight 中のアクセスを制限しやすくする。しかし device で使える effect の限定、停止性、有限 arena／queue に収まる保証は、それぞれ別の契約になる。それらを満たしても、短い依存経路、均等な仕事量、coalesced access、十分な演算密度までは得られない。Bend も負荷の再分配を行わず、equal-parts 契約は未検証としている。BendTT の証明対象は Lean 内の計算体系・checker であり、TypeScript の parser／変換や C runtime 全体を検証済みと解釈しない。([BendRT の制約](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/BendRT/main.typ#L618)、[BendTT の証明境界](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/BendTT/main.typ#L1100))

外側から純粋に見える region の内部で、所有する配列や worklist を in-place 更新する設計は可能である。こうした内部更新まで禁じる必要はなく、外部 alias の排除と競合・可視性の規則を定める方がよい。Futhark も uniqueness による in-place update と配列演算の fusion を組み合わせる。最初の GPU subset は、特殊化後の `map / scan / segmented reduce / compact / bounded loop` と独立領域への書込みを中心にすると、任意再帰から始めるより費用を説明しやすい。([Futhark、PLDI 2017](https://futhark-lang.org/publications/pldi17.pdf))

現行 Bend の `f!(x)` は逐次点から計算を GPU に渡し、結果ができてから CPU continuation を再開する。ホストは後続 command buffer を先行投入するが、ユーザーの CPU 計算と GPU 計算は交互に進む。今回の「状態管理を進める CPU と、独立 batch を評価する GPU の同時実行」は、このモデルをさらに広げる提案である。([offload の意味](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/BendRT/main.typ#L497)、[Metal の先行投入](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/comp.ts#L4925))

実測も「合法な並列計算なら常に GPU が勝つ」とは示していない。同じ M4 Max の記録には次の両面がある。秒数は build を除き、warm run 後に別プロセスを起動して終了まで測ったもので、kernel 単体時間ではない。([記録 pin](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bench/runtime/_pin_/apple_m4_max.txt)、[計測方法](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/gen_pins.ts#L60))

| Bend workload | 並列 CPU | Metal | 並列 CPU 時間／Metal 時間 |
|---|---:|---:|---:|
| merkle | 0.422 s | 0.071 s | 5.94 |
| kmeans | 0.268 s | 0.191 s | 1.40 |
| lexer | 0.198 s | 1.075 s | 0.18 |

pin は **2026-09-17、stamp `d0db7b3e`**。上記リンクは現 checkout の HEAD `f0cf0a7` に固定した記録であり、stamp の commit はローカルで解決できなかった。並列 CPU の実 thread 数も pin にない。merkle は大きな木計算をまとめ最終 checksum を返す一方、lexer は大量の独立行でも linked-list String を逐次 FSM で読む。表現や負荷の偏りは性能差の候補だが、この記録だけで原因は特定できず、lexer の敗因を CPU 協調と断定もできない。([merkle](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bench/runtime/merkle/main.bend#L2)、[lexer](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bench/runtime/lexer/main.bend#L2))

## Apple の同期例は何を解消するか

指定された Apple の例は、この構想の基礎に合う。CPU が frame `n+1` 用 buffer に書く間、GPU は frame `n` の別 buffer を読む。FIFO の pool を循環し、`MaxFramesInFlight=3` と同数の semaphore で発行数を抑え、`addCompletedHandler` で GPU 完了後に permit を返す。CPU の書込みは、その buffer を使う command の commit 前に完了させる。3 本という数は drawable 上限に合わせた描画例の選択であり、汎用計算の最適本数ではない。([ユーザー指定の Apple 文書](https://developer.apple.com/jp/documentation/metal/synchronizing-cpu-and-gpu-work)、[本文を確認した公式 Markdown](https://developer.apple.com/documentation/metal/synchronizing-cpu-and-gpu-work.md))

ここから得られるのは、別々の仕事が同じ buffer の再利用を待つ依存を減らす方法である。`input[n+1] = f(result[n])` という意味上の依存は残る。非同期に待つことで CPU thread を別の仕事に使えても、その一件の latency は縮まらない。逆に次 batch が前 batch の commit に依存しないなら、CPU の I/O／snapshot 準備と GPU の計算を重ねられる。

GPGPU では出力の寿命を追加で扱う。描画例の CPU-write／GPU-read 入力は GPU が読み終えれば返せるが、GPU が書いた出力 slot は **GPU 完了と、CPU の結果構築・後続 GPU を含む全 consumer の完了の両方**を待つ。completion callback 自体は CPU の I/O や意味上の commit の完了を表さない。入力と出力の lease を分離してもよい。現 Metalic の lease も CPU 結果構築まで保持するが、現在は一 slot の同期実行である。([バッファ再利用の契約](バッファ再利用の比較検証.md))

提案する API の骨格は次のようになる。epoch は読み取る partition／依存集合の版を表し、所有権による物理的な寿命と分けて扱う。

```text
snapshot = CPU_state.snapshot(epoch)
flight = submit(plan, ReadSnapshot(snapshot), Owned(output_arena), budget)
// CPU は独立した次 batch の準備や I/O を進める
flight = flight.then_gpu(next_plan)  // host の意味判断が不要な後段
output, delta, summary = await(flight)
CPU_state.commit_if_current(epoch, validate(delta, summary))
// output の全 consumer が終わってから、その lease を返す
```

GPU の完了だけで snapshot の意味上の一貫性は保証されない。CPU は read set／partition epoch など、計算が実際に依存した版を検証し、競合時は破棄・再試行する。その追加費用も計上する。無関係な更新まで単一の global epoch で失効させる必要はない。future の cancel／drop が使用中の buffer の即時解放にならない契約も必要になる。validator が毎回全 IR を再走査する設計では、summary に集約した利益を CPU 側で失いかねない。

## アムダールの法則に協調費用を足す

固定仕事量について、重ならない区間なら次で考えられる。`T0` は同じ入出力を作る native CPU 基準時間、`W` は GPU 候補部分、`C` は残る CPU 部分、`s` は候補部分の実効速度比である。`H` は追加費用のうち依存経路上で隠せない部分だけを数える。([Amdahl の原論文](https://www.cs.cmu.edu/~18742/papers/Amdahl1967.pdf))

```text
T0 = C + W                  p = W / T0
Th = C + W/s + H
Speedup = 1 / [(1-p) + p/s + H/T0]
損益分岐: H < W(1 - 1/s)
```

`s` には GPU 内の barrier、reduction、worklist、無効 lane も含める。`H` には追加の準備・encode・必須 feedback・結果消費・queue 待ちなどを入れるが、重なった時間や GPU interval に含む仕事を二重に足さない。region 自身が遅く `s≤1` になる問題と、速い region の利益を `H` が消す問題は分けて調べる。

次表は **すべて仮定値で、Metal／M5 の測定ではない**。CPU 基準 100 ms、`p=.95, s=20` とし、残る CPU 5 ms、GPU 4.75 ms、一往復の追加費用を仮に 50 µs と置いた。それ以外の追加費用はゼロという楽観条件である。([再実行した計算 script](<../research_notes/CPU GPU 協調 の 実ワークロード評価/sensitivity.py>)、[計算表](<../research_notes/CPU GPU 協調 の 実ワークロード評価/sensitivity.csv>))

| 必須 host feedback 回数 | 追加 H | 一件の時間 | 速度比 | GPU 無限高速時の上限 |
|---|---:|---:|---:|---:|
| 1 | 0.05 ms | 9.80 ms | 10.20 | 19.80 |
| 10 | 0.50 ms | 10.25 ms | 9.76 | 18.18 |
| 100 | 5 ms | 14.75 ms | 6.78 | 10.00 |
| 1000 | 50 ms | 59.75 ms | 1.67 | 1.82 |

さらに仮の `T0=10 ms, p=.98` で 200 回、各 50 µs の必須 feedback があれば、残る CPU は 0.2 ms、追加費用だけで 10 ms になる。GPU の計算をゼロ時間にしても **10.2 ms** で、CPU 基準を超えられない。ユーザーの懸念はこの場合にそのまま当たる。ただし **77 kernels と 77 回の host feedback は違う**。現 Metalic は77 dispatch を最後の host wait 一回で処理する。ナノパスは意味・検証の単位として保ち、各 pass の末尾を CPU 待ちに固定しない。([現行計測](バッファ再利用の比較検証.md))

独立 request の連続処理は別のモデルになる。理想的な定常状態の開始間隔は、概ね `max(CPU需要/CPU容量, GPU需要/GPU容量, I/O需要/I/O容量, 共有DRAM traffic/持続帯域)` 以上になる。GPU 化で一件の latency や CPU 余力が改善しても、I/O が律速なら throughput は増えない。UMA は明示 copy を省ける条件であり、CPU 初期化・GPU の各 pass・CPU 全出力走査の traffic は残る。同時実行で共有帯域を奪い合う可能性もある。batch 拡大には収集待ちと保持メモリが伴うため、latency と throughput を別に測る。([Apple の storage mode](https://developer.apple.com/documentation/metal/choosing-a-resource-storage-mode-for-apple-gpus)、[Roofline](https://escholarship.org/content/qt5tz795vq/qt5tz795vq.pdf))

## 実ワークロードではどこを境界にするか

以下は先行実装と依存構造からの設計評価であり、Metalic での達成値ではない。CPU 状態の複雑さより、状態を観測・更新する単位で判断する。

| workload | CPU が決めるもの | GPU にまとめる領域と戻すもの | 判断 |
|---|---|---|---|
| 一括 frontend／将来の full build | file graph、interface、cache、I/O、後段 | 独立関数群の lex→parse→bind→局所型検査。最後に診断 summary／必要な IR | 多数の関数なら候補。backend／link を含む全体時間は別評価 |
| IDE の小さな編集 | query invalidation、version、取消し | dirty 関数だけ処理し、必要な診断を返す | 再利用後の仕事が小さければ CPU が有力。signature 変更は別 trace |
| snapshot ETL／常駐分析 query | schema／rule version、offset、transaction、plan | parse→projection→filter→aggregate／compact。batch ごとに delta／選択 row | 大きい入力と小さい結果が有望。高選択率・全結果 object 化は別条件 |
| graph／単調な program analysis | graph version、checkpoint、方針 | resident frontier→advance→filter→reduce。changed／count を返す | 広い frontier は候補。細い frontier と多数反復は厳しい |
| 小さい service／UI callback | session／transaction、次の key と I/O | 小さな helper の結果を毎回返す | 次段が結果依存なら不利。batch 待ちによる tail 悪化にも注意 |
| frame 単位の transform／粒子／画像 | input と scene snapshot | 大量変換を一括処理し、可能なら描画へ直接渡す | ゲーム・UI でも候補。細かな callback と区別する |

コンパイラでは、CPU が source と interface の snapshot を確定し、GPU が flat IR 上の pass 列を連結する。局所関数検査の間に host が symbol を一個ずつ照会する構造は避ける。一方、IDE は純粋 query の依存を使い、再評価して値が同じなら無効化の伝播を止められる。純粋性は並列実行だけでなく **再実行を省く** 根拠でもある。dirty work を減らした native CPU と比較しなければ、GPU に有利な評価になる。現在の Metalic の一 source 上限は256関数であり、一般の call／let／if や full compiler backend は未実装である。([rustc の増分 query](https://rustc-dev-guide.rust-lang.org/queries/incremental-compilation-in-detail.html)、[現在の言語と契約](../README.md))

ETL なら CPU が `offset range + schemaVersion + rulesVersion` を予約し、不変 snapshot と入力 batch を渡す。GPU は構造 index から projection、predicate、集計、出力 compact まで処理し、CPU は小さい結果を検証して offset を commit する。次 batch の I/O は独立なら並行できる。GpJSON は GPU に構造 index を残して query も行う実例であり、中間表現を戻さない方針の参考になる。ただし各 record の commit が次 record の規則を変える意味論なら、その batch 化は挙動を変える。許容される snapshot、可換 delta、独立 key、競合検出などが成立する場合に限る。([GpJSON、PVLDB 2025](https://www.vldb.org/pvldb/vol18/p3216-bonetta.pdf))

graph では CSR、visited／lattice、二つの frontier を GPU に置ける。毎反復 CPU が `changed` を読んで次を発行すれば、小さい flag でも依存往復は残る。chain の frontier がほぼ一要素なら、往復に加え GPU の幅も使えない。広い tree とは別の評価が必要である。device の active flag と事前 encode した複数反復で checkpoint を減らす案はあるが、空発行や停止確認の遅れも増える。Metal で任意 threadgroup の進捗を仮定する global spin-barrier は前提にしない。([Gunrock の frontier](https://gunrock.github.io/gunrock/gunrock.wiki/API.html)、[graph 形状と実行方式を比較する SEP-Graph](https://xiaodongzhang1911.github.io/Zhang-papers/TR-19-1.pdf))

この境界選びに直結する新しい実装例が Futhark の **2026-10-02** 記事である。逐次 graph colouring の CPU loop が device 配列を要素ごとに読むと copy／wait が繰り返されるため、`#[cpu_function]` で前処理を CPU にまとめ、最後に結果を渡して後続計算を GPU で行う。逐次部分と並列部分をそれぞれ粗く保つ方針を支持するが、明示 attribute の機能であり自動配置ではない。記事の時間を Apple UMA の予測値にも使わない。([Keeping Futhark off the GPU](https://futhark-lang.org/blog/2026-10-02-cpu_function.html))

## Metalic で判断を確かめる次の比較

現実装は小言語の frontend を GPU で動かしており、任意のユーザー関数を GPU 実行コードに変換する系ではない。既存の256関数・77,713 bytes・48,896 node の測定は、buffer 初期化を減らすと warm frontend p50 が2.137→1.360 msになった。ただし process／library setup、最終 AST／JSON 化は外にあり、最後の一標本の AST 構築だけで約24〜28 msかかる。常駐 worker と公開 GPU IR handle も未実装である。TS oracle は性能 baseline ではなく、host と GPU の別々の中央値の差も readback 時間ではない。ここから CPU 比の速度向上や `p` を推定できない。([保存済み比較と計測範囲](バッファ再利用の比較検証.md))

最初に、同じ frontend を最適化した native CPU、全 pass GPU 常駐、pass 群ごとの強制 host feedback で比較する。GPU 二方式は kernel・有効仕事・launch 上界を揃え、確認回数だけを1／4／16群などに変える。count に基づく発行量縮小は別実験にする。強制 feedback は比較専用に隔離し、通常経路に中間 readback を加えない。現在の上限内の1／16／256関数と、短い多数関数／長い単一式を使い、summary 出力と全 AST 出力も公平に揃える。

次に frontier 実験で、chain／grid／広い tree／degree-skew graph を使い、native CPU、GPU 毎反復確認、複数反復ごとの checkpoint を比べる。まず固定反復数で同じ有効仕事を保ち、その後に正しい早期停止を含む全体評価を行う。frontier 幅、反復数、空発行、CPU wakeups を記録すれば、協調頻度と並列幅のどちらが失敗原因かを分けられる。

汎用用途の検証には snapshot ETL を加える。例えば64 KiB／1 MiB／16 MiB batch と低／高選択率を仮の感度点にし、CPU の規則更新と commit を含めて一 slot／複数 in-flight を比較する。これらの容量は提案であり目標値ではない。共通して cold CLI と warm 常駐実行、setup、入力待ち、結果消費、latency 分布と throughput、保持容量、共有帯域競合を分け、CPU の single-thread／multicore の良い実装と比較する。版不一致・取消し・再試行でも結果と寿命の正しさを確認する。

この検証で必要なのは、新しい言語機能より、同じ仕事に対して必須 feedback と結果量を独立に変える計測である。**MSL 4.0 のまま着手でき、今回の判断に4.1や OS 更新は必須ではない。** 自動 CPU/GPU 配置は、その結果を使って仕事量・幅／深さ・常駐の有無・返却量・queue 待ちから領域単位で選ぶ段階へ進める。([現在の方針と通常経路の契約](../AGENTS.md))
