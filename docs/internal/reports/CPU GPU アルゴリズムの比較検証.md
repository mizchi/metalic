# CPU GPU アルゴリズムの比較検証

**3種類を実装した結果、大きな SHA-256 Merkle 木では GPU の利益を確認できた。ヒストグラムは入力の常駐と分布次第で、安定フィルタ圧縮は最適化した CPU が速かった。** 純粋な並列計算でも、CPU 実装の強さ・演算密度・中間配列の traffic・結果回収まで含めて判断する必要がある。

2026-11-15、Apple M5／macOS 26.6.2／MSL 4.0、利用可能な論理 CPU は10。手書き MSL と native C++ を比較した。新言語からの自動 GPU コード生成や CPU/GPU 自動配置の測定ではない。前段の [CPU GPU 協調回数の比較](<CPU GPU 協調回数の比較検証.md>)を踏まえ、一つの仕事の全段を GPU 内で連結し、最後だけ host が待つ。

## 実装した3種類

| アルゴリズムと仕様 | GPU の配置 | CPU baseline |
|---|---|---|
| SHA-256 Merkle 木。64-byte leaf を SHA256、内部は SHA256(left32＋right32)。奇数末尾を複製し、空木は SHA256(empty) | leaf hash を要素ごとに並列実行し、木の各階層を続けて発行。最終 root は32 bytes | CommonCrypto の SHA-256。単一実行と階層ごとの GCD 並列 |
| 256-bin ヒストグラム。各 byte の件数を返す | SIMD-group ごとに複製した threadgroup atomic bins、partial 集計、最終 reduction の2 dispatch | worker 内4系列の private histogram と最終 merge。単一／GCD 並列 |
| u32 安定圧縮。`(value & mask)==0` を選択し元の順序を保つ。既定 mask=1 | 局所 prefix scan、block sums の階層 scan、offset 加算、scatter | 単一版は分岐なしの書込み・位置更新。並列版は chunk count→offset→独立範囲への scatter |

[native/workloads.metal](../../../native/workloads.metal) に kernel、[native/workloads_cpu.h](../../../native/workloads_cpu.h) に CPU 版、[native/workloads_plan.h](../../../native/workloads_plan.h) に arena／dispatch 計画、[native/workloads.mm](../../../native/workloads.mm) に資源所有と実行を分けた。ABI は [native/contract.h](../../../native/contract.h)、公開実験型は [src/contract.ts](../../../src/contract.ts)。生成入力を測る [src/workloads.ts](../../../src/workloads.ts) のハーネスを追加した。

GCD の task 数は利用可能 CPU の最大4倍で、small job では1にする。40 task を40物理コアと解釈しない。OS が実際の thread 配置を決める。CPU 最適化はここに実装した2方式の範囲であり、あらゆる native library の最速値という意味ではない。

## 測定範囲を揃える

Merkle は1〜262,144葉、ヒストグラムは4 KiB〜64 MiBで uniform／全byteが7の hot、圧縮は256〜16,777,216要素を測った。圧縮の性能条件は mask=1、選択率は約50%。全選択・選択なしは正しさの検査に含め、速度表とは分ける。count・seed と実入力の SHA-256 を保存し、全方式で同じデータを使う。

一つの native process／library 内で、次の4方式の順序を各 round で回転させた。3 warmup＋15標本で、資源と CPU 出力領域は確保済み。CPU との速度比には単一／並列の p50 のうち速い方を使う。

| 方式 | 時間に含める仕事 |
|---|---|
| cpu-serial / cpu-parallel | 同じ全出力を生成し、CPU が全結果を checksum で消費 |
| gpu-resident | 事前に書いた shared 入力、encode、GPU、完了待ち、最終 count と全出力の CPU 消費 |
| gpu-upload | resident と同じ処理に、その回の CPU 入力→shared buffer の memcpy を追加 |

全出力は flat buffer として生成する。圧縮だけ GPU の件数を返して CPU 版に全配列を作らせるような比較はしない。検証用 checksum は全出力を読むが、配列を JSON オブジェクトへ変換する時間は含まない。**library／process setup、確保、入力生成、基準結果の生成、計測後の全要素照合、JSON／IPC は warm 時間の外**である。API／CLI の全応答時間という主張はしていない。

GPU は intermediate count を host に返さず、全 dispatch の後に一回待つ。資源は既存 BufferLease で CPU 消費後まで保持する。全 arena を shared とした原 API の MTLCommandQueue を使い、MSL 4.1 は不要だった。実装が要求する SIMD width 32、256-thread group、threadgroup memory は各 pipeline で検査する。[Apple の grid 設計](https://developer.apple.com/documentation/metal/calculating-threadgroup-and-grid-sizes)に従い、協調 scan では padded lane も barrier に参加させる。

## 最終コードの結果

[試行3](../../../measurements/apple-m5-workloads-trial3.json)を主表とし、同じ source hashes の [試行4](../../../measurements/apple-m5-workloads-trial4.json)で再確認した。以下は warm p50、単位 ms。GPU 列には完了待ちと CPU 消費を含み、コピー込みの速度比は `CPU best / gpu-upload`。

| ワークロード | CPU best | GPU 常駐 | GPU コピー込み | コピー込み速度比 |
|---|---:|---:|---:|---:|
| Merkle・256葉／16 KiB | 0.080 | 0.291 | 0.345 | 0.23 |
| Merkle・65,536葉／4 MiB | 3.676 | 4.537 | 4.244 | 0.87 |
| Merkle・262,144葉／16 MiB | 12.874 | 7.290 | 5.428 | **2.37** |
| histogram・16 MiB uniform | 1.022 | 0.623 | 0.935 | 1.09 |
| histogram・64 MiB uniform | 3.546 | 2.824 | 4.163 | 0.85 |
| histogram・16 MiB hot | 0.752 | 2.754 | 3.101 | 0.24 |
| compact・1,048,576要素／4 MiB | 0.165 | 0.273 | 0.326 | 0.51 |
| compact・16,777,216要素／64 MiB | 2.107 | 3.558 | 5.067 | 0.42 |

再試行でも結論の方向は同じだった。大きな Merkle は CPU 21.081 ms／GPU 常駐6.665 ms／コピー込み5.446 ms、コピー込み3.87倍。CPU の scheduling や動作条件も変わるため、2.37〜3.87を普遍的な倍率にはしない。主表の大 Merkle の p95 は CPU 19.178 ms、GPU コピー込み9.061 ms、再試行は31.367／9.440 msだった。

64 MiB uniform histogram の再試行は CPU 3.905 ms／常駐2.764 ms／コピー込み4.181 ms。常駐なら利益があり、copy を払うと負ける条件だった。16 MiB uniform はコピー込みでも1.09／1.08倍だったが、この程度の差を安定した優位と断定しない。hot 分布は両試行で CPU が速かった。64 MiB compaction も再試行は CPU 3.058 ms／常駐5.009 ms／コピー込み7.310 msで、CPU 優位が残った。

GPU 常駐よりコピー込みの p50 が短い箇所もある。copy の利益を意味せず、方式間の GPU 実行区間や scheduling が異なる。別々の中央値を引いて copy 時間を求めない。対応する prepareUs を見ると、主表の upload copy 区間 p50 は Merkle 16 MiBで0.346 ms、histogram 64 MiBで1.337 msだった。GPU／CPU の周波数、OS 負荷、core 配置は制御しておらず、p95 も15標本の参考値である。

API 入口で options 内の余分な jobs が入力を上書きしないよう修正し、[試行5](../../../measurements/apple-m5-workloads-trial5.json)も保存した。試行3／4は commit `fd6244a` で再現でき、試行5も native／MSL のソースは同じである。最新値は次になる。

| 最新試行の大入力 | CPU best | GPU 常駐 | GPU コピー込み | コピー込み速度比 |
|---|---:|---:|---:|---:|
| Merkle・262,144葉／16 MiB | 13.526 | 4.942 | 5.304 | 2.55 |
| histogram・64 MiB uniform | 3.212 | 2.129 | 3.061 | 1.05 |
| compact・16,777,216要素／64 MiB | 2.582 | 4.066 | 5.488 | 0.47 |

大 Merkle と compaction の優劣は同方向だった。histogram のコピー込みは試行3／4のCPU優位から小差のGPU優位へ変わっており、明確な高速化とは扱わない。中規模 Merkle も動作条件で優劣が変わったため、一回の結果から自動配置の固定閾値を決めない。

## CPU を改善すると結論が変わった

[初回](../../../measurements/apple-m5-workloads-trial1.json)の compaction は CPU の predicate 分岐が残り、GPU コピー込み1.39倍だった。CPU を分岐なしにして再比較した [試行2](../../../measurements/apple-m5-workloads-trial2.json)では、その優位が消えた。GCD の chunk 数も増やし、性能コアと効率コアの仕事を細かく配れるようにした。

並列の分岐なし scatter は、選択されなかった末尾の値を次 chunk の領域へ書かない guard を持つ。空の選択範囲も含めて所有範囲を守る。単に `out += selected` に直すだけでは、別 chunk の正しい出力を上書きしかねない。

GPU 側は試行2で SHA の64 round 展開と、SIMD 内同値の histogram atomic 集約も試した。明確な改善を確認できなかったため最終コードは単純な kernel に戻した。試行間には CPU コードや動作条件の違いもあり、各変更の独立した速度比は主張しない。初回は commit `09e18ee`、試行2は `d90e8dd` の source hashes で照合できる。過去の hash は書き換えない。

## 言語処理系への判断

Merkle のように、計算が多く、階層間の依存を GPU 内で解決し、最後の小さい root だけ CPU が使う領域は有望である。CPU はファイル・版・cache／commit を管理し、GPU に大量の fingerprint／hash をまとめる設計候補になる。実用の任意長 file hash や incremental tree は、今回の固定64-byte leaf の測定とは別に検証する。

histogram は常駐データへの複数処理をまとめられる場合に候補になる。compaction は scan と scatter が GPU 上で動くことだけでは CPU より速くならなかった。コンパイラの小さな IR 配列を毎回 GPU に渡す根拠にはできない。前後の GPU pass と融合して CPU 回収や中間 traffic を省く設計なら別の費用になるが、その効果は今回未測定である。

保持容量も確認が必要である。pool は power-of-two の最大容量を保持し、guard も含む。主表の大 compaction 時は、それまでに確保した source と arena の合計384 MiBを保持していた。これは CPU scratch や reference、driver を含む RSS ではない。速度と同時に arena の上限を決める必要がある。

## 検証と再実行

`just test` は37件が通過した。Merkle は Node の SHA-256 と、空・単葉・奇数・多階層を照合。histogram は独立 byte count、compaction は JS の逐次 filter と照合し、65537要素を使って階層 scan と並列 CPU の全選択／選択なしも確認した。全性能標本も timer 後に native CPU との全要素一致を検査している。

`just validate` は従来646実行に3種類の workload 92 GPU 実行と CPU 対照を加え、計738 GPU 実行が通過した。poison memory と列ごとの logical guard により、長い入力から短い入力、空、群境界、偏り、階層 scratch を検査した。手順は [検証記録](<../research_notes/CPU GPU アルゴリズムの比較検証/verification.md>)に保存した。

```sh
just test
just validate
just bench-workloads
```

全84条件、各15標本と phase time・入力 hash・出力 checksum・source hashes は保存 JSON を参照。CPU/GPU の自動選択はまだ追加していない。
