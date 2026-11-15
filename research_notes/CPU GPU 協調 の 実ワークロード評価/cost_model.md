# CPU が状態を管理し GPU が純粋な領域を実行する場合の費用モデル

調査日: 2026-11-15。実測は Metalic の既存ログを使い、新しい GPU 計測は行っていない。数式から作る感度表はすべて仮定値で、M5 や Metal の境界時間を予測するものではない。MSL 4.0 のまま判断・検証できる内容である。

## どの程度の協調なら GPU 化の利益が残るか

### Takeaway

CPU が状態を持つことより、**一件の仕事で GPU の結果を待って CPU が次を決める回数と、その依存鎖の長さ**が重要になる。固定の仕事量について、重ならない段階として数えられるなら、まず次を使える。

```text
T0 = C + W                      CPU 基準実装の一件の時間
p  = W / T0                     その実装で GPU 候補領域が占める割合
s  = W / G                      候補領域の実効 GPU 速度比
T_hybrid = C + G + H = C + W/s + H

Speedup = 1 / [(1-p) + p/s + H/T0]
Speedup_upper(s→∞) = 1 / [(1-p) + H/T0]   ※ H を固定した場合
GPU 化の損益分岐: H < W(1 - 1/s)
```

`C` は残る CPU 処理、`G` は GPU 上で同じ結果を作る実際の仕事、`H` は追加費用のうち依存経路上で隠せなかった時間である。`G` には GPU 内の reduction、barrier、worklist 管理、無効 lane や上界発行など、その実装に必要な仕事も入れる。「GPU が演算だけをしたなら」のピーク値を `s` にしない。

### Cited Findings

- Amdahl の議論は、一件の固定仕事量で残る逐次処理が高速化を制限することを示す。1967 年の機械での比率を現代のワークロードへ流用する根拠ではない。上式はその考え方に追加費用を明示したもの。([Amdahl 1967, 原論文](https://www.cs.cmu.edu/~18742/papers/Amdahl1967.pdf))
- 物理的な shared system memory を CPU と GPU が使えることと、結果をいつ読めるかは別である。Apple は CPU/GPU の同期のため `MTLSharedEvent` を提供し、GPU が CPU の処理と signal を待ってから先へ進む例も示す。([Apple: storage mode](https://developer.apple.com/documentation/metal/choosing-a-resource-storage-mode-for-apple-gpus)、[Apple: CPU/GPU events](https://developer.apple.com/documentation/metal/synchronizing-events-between-a-gpu-and-the-cpu))

### Inferences

- `p` は **同じ入力と同じ出力契約の、最適化した native CPU 実装**で計る。パーサなら同じ AST・診断を作る CPU パーサ、列指向変換なら CPU の scan/filter/group-by が基準になる。可能なら GPU 用の列配置と同じ CPU 実装、および CPU に最適な別実装の両方を用意する。高速な CPU 並列版も比較に含める。
- GPU 実行の `GPU 時間 / 全体時間` は `p` ではない。TypeScript oracle は正しさの比較対象であり、最適化した CPU 基準や GPU の速度比を供給しない。純粋・アフィンという合法性も `p`、並列幅、メモリアクセス効率、`s` を決めない。
- `H` に入れるものは、追加の準備・encode/dispatch、必須の CPU↔GPU 所有権移行と通知、追加の出力構築・消費、資源待ちなどの**非重複部分**。CPU 基準にもある構築・消費はすでに `C`/`W` に含まれる。GPU interval に入った barrier を再び `H` に足さず、CPU 待ち時間に含まれる GPU 演算も二度足さない。
- 一つの近似は `H = H0/B + Σ_i L_i + Δprepare + Δconsume + Q`。`B` は独立仕事の batch、`L_i` は不可避な依存境界の増分、`Q` は隠せない queue 待ち。メモリ競合による減速は `G` または別の増分のどちらか一方へ計上する。各項が独立・一定だとは限らず、実装の timeline から非重複区間を決める必要がある。
- 境界一回の追加費用を仮に `l`、その領域の CPU 時間を `w` とすると、粒度の必要条件は `w > l/(1−1/s)`。仮に `s=20` なら `l=20/50/200 µs` に対し `w>21.1/52.6/210.5 µs`。これらの `l` は説明用の仮定である。
- 目標速度比を `R` とすると、許される追加費用の比率は `H/T0 ≤ 1/R−(1−p)−p/s`。仮に `p=.95, s=20` で 8 倍を狙うなら、予算は元の CPU 時間の 2.75% 以下。10 倍なら 0.25% 以下になる。境界時間の普遍定数を探すより、ワークロード全体の予算を先に定めやすい。

### Gaps

- 現時点の Metalic には、この意味での native CPU の性能基準がない。既存ログから実用コンパイラの `p` や `s` は推定できない。
- CPU と GPU が実際に重なる DAG、GPU 化でアルゴリズムや必要仕事量が変わる場合は、この加算モデルの前提を外れる。後述の依存経路と資源負荷へ分解する。`H` が負荷や `s` と変わる場合、上限式はそれを固定した条件付きの上限である。

## 依存境界が増えると、どのように破綻するか

### Takeaway

一件が 100 ms なら許せる協調が、一件 10 ms の incremental 処理では負けにつながる。**kernel 数と CPU feedback 回数を同一視しない**。多数の nanopass を一度に発行した GPU DAG と、各 pass の結果を CPU が見て再発行する設計は別の費用になる。

### Cited Findings

- 手元の MSL 4.0 実装は、大モジュールで 77 dispatch を使い、host wait は最後の一回である。したがって dispatch 数をそのまま CPU 往復数にはできない。([バッファ再利用の報告](../../reports/バッファ再利用の比較検証.md)、[生ログ](../../measurements/apple-m5-buffers-trial2.json))
- 逆に、Apple の event の例では、一つの command buffer の中でも GPU→CPU handler→GPU という依存を作れる。commit 回数が一回でも CPU feedback の stall は消えない。([Apple: CPU/GPU events](https://developer.apple.com/documentation/metal/synchronizing-events-between-a-gpu-and-the-cpu))
- 2025 年の Celerity の論文は、高水準の命令 graph に allocation・coherence・transfer・kernel を含め、先行解析と非同期実行を重ねる。これは多 GPU/SYCL の研究であり、Apple の境界時間の実測には使えない。([Knorr et al., arXiv v1, 2025-03-13](https://arxiv.org/html/2503.10516v1))
- 2026 年の SET の preprint は、CUDA Graph を使っても host/device の同期と scheduler に隙間が残るとして、独立 job の event chain と複数 in-flight graph で throughput を改善する。これも CUDA の結果で、Metal で同じ速度比を保証しない。([Li et al., arXiv v1, 2026-06-03](https://arxiv.org/html/2606.05495v1))

### Inferences

以下は**すべて仮定値**。CPU 基準 `T0=100 ms`、候補割合 `p=.95`、GPU 領域速度比 `s=20` とする。残る CPU は 5 ms、GPU の仕事は 4.75 ms。`N` は同じ一件の依存経路にある必須 CPU↔GPU 往復、`l` は GPU/CPU の有用処理を除いた一往復の追加時間とする。`H=N×l` 以外の追加費用はゼロに置いた、楽観的な感度分析である。

| 仮の `l` | 必須往復 `N` | 追加 `H` | `H/T0` | 一件の時間 | 速度比 `s=20` | 速度比の上限 `s→∞` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 µs | 1 | 0.01 ms | 0.01% | 9.76 ms | 10.25 | 19.96 |
| 10 µs | 10 | 0.10 ms | 0.10% | 9.85 ms | 10.15 | 19.61 |
| 10 µs | 100 | 1 ms | 1% | 10.75 ms | 9.30 | 16.67 |
| 10 µs | 1000 | 10 ms | 10% | 19.75 ms | 5.06 | 6.67 |
| 50 µs | 1 | 0.05 ms | 0.05% | 9.80 ms | 10.20 | 19.80 |
| 50 µs | 10 | 0.50 ms | 0.50% | 10.25 ms | 9.76 | 18.18 |
| 50 µs | 100 | 5 ms | 5% | 14.75 ms | 6.78 | 10.00 |
| 50 µs | 1000 | 50 ms | 50% | 59.75 ms | 1.67 | 1.82 |

これに対し、同じく仮の `T0=10 ms, p=.98, s=20` では、残る CPU は 0.2 ms、GPU は 0.49 ms となる。

- 一つの resident graph、仮の境界 50 µs 一回: **0.74 ms、13.51 倍**。
- 同じ仕事を 200 回の CPU feedback に分割、仮の境界 50 µs: **10.69 ms、0.94 倍**。
- 後者は GPU の仕事をゼロ時間にしても **10.2 ms、上限 0.98 倍**。kernel の改善だけでは CPU 基準に追いつけない。

依存している 200 回を一件のまま batch 化して消すことはできない。独立 request を同時に進めて待ちを隠すか、CPU の判断を GPU 内の count/flag/indirect dispatch/reduction に置くか、CPU がまとめて判断できるアルゴリズムへ変える必要がある。GPU 内へ移す判断自体の仕事・メモリ通信も `G` に算入する。

感度表は [sensitivity.py](sensitivity.py) と [sensitivity.csv](sensitivity.csv) で再生成できる。外部依存はない。`python3 sensitivity.py > sensitivity.csv`。

### Gaps

- 10/50 µs は Metal の測定値ではない。実際には queue、CPU scheduling、payload、同期方法、GPU 負荷で分布が変わる。各 `L_i` を同じ定数にしたモデルは一次の予算確認に限る。
- 形式上純粋でも、巨大な依存 chain、偏った再帰、pointer chasing、低い演算密度なら、`s=20` 自体が成立しない。

## Apple の CPU/GPU 同期の例は、どの依存を解消するか

### Takeaway

ユーザー指定のページは、この構想の土台に合う。**別々の仕事が同じ buffer の再利用を待つ依存**を、複数 buffer と完了時の返却で避ける例である。一件の次段階が GPU の計算結果を必要とする依存は別に残る。

### Cited Findings

- 例では CPU が frame `n+1` の buffer に書く間、GPU は frame `n` の別 buffer を読む。CPU の書込みを、その buffer を参照する command の commit 前に完了させる。([ユーザー指定の Apple 日本語ページ](https://developer.apple.com/jp/documentation/metal/synchronizing-cpu-and-gpu-work)、[全文を確認した公式 Markdown](https://developer.apple.com/documentation/metal/synchronizing-cpu-and-gpu-work.md))
- FIFO の buffer pool を循環し、同数の counting semaphore で in-flight 件数を制限する。`addCompletedHandler` が GPU の command buffer 完了後に semaphore を signal し、buffer を再利用できるようにする。([同ページ](https://developer.apple.com/documentation/metal/synchronizing-cpu-and-gpu-work.md))
- 例の `MaxFramesInFlight=3` は、描画用 drawable の上限に合わせている。本文は CPU→buffer→GPU の描画例で、汎用計算の最適 buffer 数や readback 時間を計測したものではない。([同ページ](https://developer.apple.com/documentation/metal/synchronizing-cpu-and-gpu-work.md))

### Inferences

- コンパイラなら frame を独立 module/batch に読み替えられる。CPU が入力・環境 snapshot を用意し、GPU が前の module の純粋な領域を処理する。buffer は同じ物理メモリを双方が同時に書くためではなく、各仕事の所有期間を分けるために増やす。
- `next_input = f(previous_GPU_result)` なら、非同期 API や三つの buffer があっても結果が出る前に次の入力を完成できない。待つ CPU thread を他の仕事へ回すことと、その依存の latency を消すことは異なる。
- GPU が結果を書く場合の slot 寿命は `CPU prepare → GPU in-flight → CPU/GPU consumers → free`。CPU が結果を読んでいる間に同じ slot を次の入力で上書きしない。pool へ返せるのは producer GPU の完了と、依存する全 consumer の完了の両方を満たした時点である。input/output の lease を別にする設計でもよい。現在の Metalic の lease が CPU 結果構築まで保持される契約とも対応する。([実装契約](../../reports/バッファ再利用の比較検証.md))
- 指定ページの completion callback は GPU command の完了を知らせるもので、CPU の I/O、結果 materialize、意味上の state commit の完了を表さない。入力を GPU が読み終えれば返せる描画例の規則を、GPGPU の出力 slot へそのまま適用しない。

### Gaps

- localized ページ本文は JavaScript 必須だったため、同じ識別子の Apple 公式 `.md` を確認した。この例だけでは、GPU が書く結果の CPU 消費や、状態 snapshot の意味上の独立性は設計されない。

## 一件の latency と、連続処理の throughput をどう分けるか

### Takeaway

一件の CPU→GPU→CPU の依存鎖は、別 request を進めても短くならない。一方、独立 request が十分あれば、CPU の状態処理と GPU の計算を重ねられる。throughput は単純な合計でなく、**最も混んだ資源の一件当たり需要**で制限される。

### Cited Findings

- Work/span のモデルでは、固定 DAG の実行時間は仕事量由来の下限と最長依存経路由来の下限を持つ。Blumofe–Leiserson の `T1/P + O(T∞)` の結果は fully strict な計算と work stealing の条件を持つ。異種 CPU/GPU や任意の GPU 内 global barrier にその保証をそのまま適用はできない。([Blumofe and Leiserson 1999](https://www.cs.utexas.edu/~venkatar/sys_perf_analysis/ws_theory.pdf)、[DOI](https://doi.org/10.1145/324133.324234))
- Roofline は持続的なメモリ帯域と DRAM traffic 当たりの仕事を使って到達可能な性能を制約する。公称演算ピークだけでは時間を見積もれない。([Williams et al. 2009](https://escholarship.org/content/qt5tz795vq/qt5tz795vq.pdf))
- Apple GPU の shared resource は CPU と GPU の双方からアクセスできる system memory に置かれる。UMA はこの物理メモリを利用できる条件である。([Apple: storage mode](https://developer.apple.com/documentation/metal/choosing-a-resource-storage-mode-for-apple-gpus))

### Inferences

一般の task DAG では、latency は少なくとも最長依存経路と各資源の負荷下限を満たす。純粋な小仕事が大量にあっても、次の frontier を決める chain が長ければ span が残る。「CPU のコードに状態が多い」という記述から逐次時間は決まらない。CPU 側の依存を伴う実時間を計る。

独立 request の理想的な定常状態なら、開始間隔の下限は概ね次になる。

```text
II ≥ max(d_CPU / effective_CPU_capacity,
         d_GPU / effective_GPU_capacity,
         d_IO / effective_IO_capacity,
         Q_shared_memory / sustainable_shared_bandwidth)
throughput ≤ 1/II
```

`d` は一件の資源需要で、同時実行性能を実測した capacity を使う。GPU を二 stream にしただけで capacity が二倍とはしない。queue 待ちと必要な in-flight 件数・メモリ上限も別に管理する。CPU/GPU が共有帯域を取り合えば `d` 自体が増える。copy がなくても、CPU 初期化、GPU の多数 pass、CPU 全結果走査の traffic は残る。cache に収まる場合は DRAM byte と論理アクセス byte を区別する。

I/O の例も**仮定値**とする。CPU で I/O 10 ms→状態処理 2 ms→計算 8 ms の順なら一件 20 ms。GPU が計算を 8 倍にして追加費用 0.2 ms なら一件 13.2 ms、1.52 倍になる。

しかし既に独立 request が pipeline 化され、一つの有効 CPU 資源が一件 10 ms の仕事、I/O 資源も一件 10 ms を使うなら、CPU 基準の開始間隔は 10 ms、100 件/s。GPU 化後の CPU 需要 2.2 ms、GPU 需要 1 ms でも、I/O が 10 ms のままなら **100 件/s の上限は変わらない**。CPU の余裕と一件の latency は改善する。実際の I/O の並列容量や native CPU 並列版を変えた場合は、その資源需要で計り直す。

batch は固定の準備を一件当たりへ償却する一方、収集待ちを生む。例えば timeout なし・独立 Poisson 到着・常に `B` 件を満たしてから発行するという仮定なら、平均収集待ちは `(B−1)/(2λ)`。`B=32, λ=1000 件/s` で **15.5 ms** になる。これは待ち順から導いた仮定モデルで、GPU 実測ではない。interactive incremental 処理では batch 最大件数だけでなく deadline/timeout を設ける方が検証しやすい。

### Gaps

- 最長経路だけではメモリ競合、有限 buffer、head-of-line blocking、到着 burst、tail latency を予測できない。queue が伸びる高負荷と、無負荷の一件は別に測る。
- CPU の状態処理を GPU の横で進めると、それ自体が shared bandwidth を奪う。GPU 単独の `G` にそのまま overlap の利益を足すと過大評価になりうる。

## 既存の Metalic の数字から何を判断し、次に何を測るか

### Takeaway

既存結果は「nanopass が多くても CPU 往復を増やさない設計」と「CPU 初期化を減らす利益」を示す。一方、**GPU の速さを最終 AST の CPU オブジェクト化や JSON 化で使い切る危険が既に見えている**。native CPU 基準と出力契約を揃える前に、実用コンパイラの速度比を結論しない。

### Cited Findings

- 同一 build・同一実行中の buffer 比較で、77,713 bytes・48,896 nodes・77 dispatch の大モジュールは、fresh の warm frontend p50 **2.137 ms**、selective の **1.360 ms**。初期化区間の p50 は **638.6→19.1 µs**。GPU interval は **1.046→1.171 ms** で、GPU 演算の改善ではない。([報告](../../reports/バッファ再利用の比較検証.md)、[全標本](../../measurements/apple-m5-buffers-trial2.json))
- frontend は source 準備・確保・初期化・encode・commit/wait を含み、process/library setup、結果の最終構築、JSON encode/output、JS parse、cleanup を含まない。同ケースの `finalMaterializeUs` は **24.151/27.844/26.908 ms**（fresh/reuse/selective）だが、これは最後の一標本で、30 標本の中央値ではない。`setupUs` は比較ケース共通の **33.951 ms** で、warm frontend の外にある。([全標本・計測注記](../../measurements/apple-m5-buffers-trial2.json))
- 診断方式の別の比較では、tree→packed で全 dispatch **149→77**、frontend p50 **1.536→1.401 ms**、GPU interval **0.610→0.530 ms**。dispatch が約48%減っても全体は約9%の改善であり、dispatch 削減率を全体の高速化率にできない。([報告](../../reports/診断集約の比較検証.md)、[全標本](../../measurements/apple-m5-diagnostics-trial2.json))
- 旧 handoff 実験の一実装では、warm な scalar `encode_submit_wait_read` p50 が **221.625 µs**、GPU interval p50 が **2.167 µs** だった。これは queue 一つ・同期往復・特定実装の観測であり、Metal の固定境界費用ではない。GPU の書込み後に CPU が 64 MiB を checksum する時間は **960.333 µs** で、既に完了した結果の消費もゼロではない。([旧 JSON](<../Metal 向け コンパイラ と 実行基盤/benchmarks/results-final.json>))

### Inferences

- host wall time と GPU interval の**別々の中央値の差**は readback 時間ではない。同じ標本でも timestamp の意味と範囲を揃えなければ、ownership handoff、queue、completion 通知、host scheduling を分離できない。旧実験の「既に完了した command を wait して scalar を読む」約 4.46 ns/回も、GPU の新たな完了を待つ境界の費用ではない。
- 出力を AST 全体とするか、compact 診断と handle のみにするか、次の nanopass が GPU resident IR を読むかで `Δconsume` は変わる。CPU 全 AST 構築を消す設計なら、その出力契約を明記する。最初に速い frontend だけを測って後から全結果消費を足すと、用途の判断を誤る。
- 比較は次の三処理を、同じ入力・結果契約・有用仕事量で固定すると原因を切り分けやすい。

| treatment | 実行と役割 | 主に分かること |
| --- | --- | --- |
| Native CPU | 最適化した native、必要なら SIMD/CPU 並列版。GPU 向けと同じ配置版も用意 | `T0, C, W` と GPU 化の機会費用 |
| Resident GPU DAG | 複数 pass を連続発行し、最終 compact 結果または同じ AST だけ回収 | GPU 内の span/traffic/dispatch、最小限の host 境界 |
| Host feedback | 同じ仕事を分割し、chunk/pass ごとに CPU が count/decision を読んで次を発行 | 不可避の CPU 協調を増やした際の latency/throughput の崩れ |

- Host feedback の判断内容を等しくした上で `N=1,4,16,64…`、独立 batch `B=1,8,32,128…`、結果量 scalar/診断/full AST を sweep する。warm 持続 process と cold process を分け、入力規模だけでなく深さ、frontier 幅、識別子偏り、失敗位置、incremental の dirty 範囲も固定する。CPU oracle は結果一致の判定にのみ使う。
- 一件全体の p50/p95/p99、段階ごとの対応した標本、GPU timeline、encode/準備の CPU 時間、必須 feedback 回数、全結果を消費し終える時刻を保存する。別に到着率を変えて throughput、queue 時間、CPU/GPU 使用量、in-flight buffer 数、初期化 byte と結果 byte、共有メモリ帯域の競合を測る。CPU 側の state/IO 処理を無負荷・計算負荷・帯域負荷に分けた同時実行が有効。
- この検証で、GPU 候補領域が大きく独立している batch full build と、狭い incremental edit が別の routing を必要とするか決められる。自動切替の入力は「純粋なら GPU」では足りず、見積仕事量・幅/深さ・結果 byte・必須往復・現在の queue と deadline が必要になる。

### Gaps

- 今回の raw logs は小さい言語 subset のもので、実用言語の macro、import、一般的な型推論、最適化、codegen を網羅しない。ここから full compiler の高速化率を外挿できない。
- `materializeUs` はまだ最終の一標本。end-to-end の消費を含む分布と、最適化した CPU baseline が次の判断に必須である。これらの計測には MSL 4.1 は必要ない。
