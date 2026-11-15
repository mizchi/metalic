# CPU GPU 配置の fit とチューニング

**GPU 向きと CPU 向きの対照を追加し、実測の速い候補へ自動配置できたかを gate にした。標準設定の最終計測は8ケースすべて合格した。** 設定を強めた試行では失敗も出たため、記録を残して再確認の方策を修正した。標準値は3標本・窓9・再探索64・切替え幅10%を維持する。

2026-11-15、Apple M5、10 logical CPU、macOS 26.6.2、MSL 4.0。OS／Xcode 更新なし。前の [自動配置の検証](<CPU GPU 自動配置の検証.md>)を、配置が合う／合わないことを繰り返し検査できる実験へ拡張した。

## 用意した処理

| ケース | 入力 | 調べる性質 |
|---|---|---|
| TEA32 小 | 64 block／512 bytes | 独立演算でも小さすぎれば GPU 発行・同期が支配する |
| TEA32 大 | 1,048,576 block／8 MiB、毎回 copy | 多数の独立した整数演算。計算密度の高い GPU 候補 |
| TEA32 常駐 | 同じ規模、GPU 入力準備済み | copy の有無を別 profile にする |
| pointer chase | 16,384ノード、単一の循環鎖 | 次アドレスが直前の load で決まる依存。内部の並列度がない |
| compaction | 1,048,576 u32、約半数選択 | scan／scatter と最適化した CPU の比較 |
| hot histogram | 16 MiB、全byte=7、毎回 copy | 集中する atomic と CPU private bins |
| balanced histogram | 16 MiB、GPU 常駐 | 小差・変動がある境界ケース |
| Merkle SHA-256 | 262,144葉／16 MiB、毎回 copy | 多段の依存を GPU 内で処理。投入状態の変化も受ける |

TEA32 は [Wheeler／Needham の原典](https://www.cl.cam.ac.uk/ftp/papers/djw-rmn/djw-rmn-tea.html)の32-cycle演算を固定 zero-key、明示的な u32 の wraparound で実装した測定用 workload。CPU は4 blockを128-bit NEON vectorで処理し、GCD 並列版も用意した。GPU だけを vector 化し、CPU を一要素ずつに制限する比較にはしない。Node の独立実装と既知の zero vector `41ea3a0a 94baa940` で全結果を照合する。

pointer chase はノード挿入で一本の循環鎖を作り、ノード0から件数分だけ辿る。訪問順の FNV 更新と最終位置を返す。CPU 並列指定でも1 worker、GPU は1 threadが同じ依存鎖を辿る。多数の独立した鎖をまとめる場合は別の並列度になり、この結果を pointer chase 全般の性能へ一般化しない。

実装は既存 `WorkloadParams` の32-byte ABI と資源所有を維持した。上限だけを正本の `native/contract.h` に追加し、TEA は8,388,608 block、pointer chase は65,536ノードまで。TEA の full-output JSON は4096 blockまでに制限する。結果の一部を省いたり、GPU 候補だけ計算を簡略化したりしない。

## 学習と評価を分ける

[ケース定義](../../../src/fit-cases.ts) の CPU／GPU 向きという値は検査用の仮説。scheduler へ渡すのはアルゴリズム・件数・実分布・入力配置だけで、仮説や固定対照の時間は渡さない。

まず全候補を同じく1回 warmup し、通常の `run` だけで各候補を既定3件学習する。`calibrate` で正解の配置を注入する方法にはしない。続いて学習 handle を解放し、別 seed の同形状入力を作る。実入力 SHA-256 が異なり、profile key は一致することを確認する。ただし hot histogram は常に全byte=7で、seed を変えても入力は同じになる。この例外は JSON の `heldInputChanged: false` に明示する。

評価は CPU 単一、CPU 並列、GPU、auto を4件ずつ、順序を回転して各96件測る。固定対照は `learn: false`、auto は自分の観測だけで学習を続ける。自 scheduler の queue は重ねず、反復する単独 job の配置を評価する。競合時の throughput は以前のバッチ実験と別に扱う。全方式で native の全要素照合を通す。

## fit の基準

配置判断には service wall time を使う。これは native 計算、全出力の CPU 消費・照合、JSON／IPC を含み、初回起動・準備・学習は別に記録する。API 時間は公開 `run` の呼出しから await 完了までを追加で測る。

| 指標 | gate の基準 |
|---|---|
| 許容候補 | 固定対照の最小 service 中央値を `b` とし、候補中央値が `1.1 × b + 10 µs` 以下 |
| 定常 fit 率 | `calibrating`／`explore`／`queue` 以外の選択の90%以上が許容候補。定常選択も全体の80%以上必要 |
| 推定 regret | 全auto選択を固定対照の中央値で評価した余分な費用が、最小候補費用合計の15%以下。探索も除外しない |
| 実 API 時間 | auto p50 が固定対照の最小 API p50の `1.25倍 + 20 µs` 以下 |
| 対照の coverage | 実測で明確な CPU 勝者と GPU 勝者が少なくとも1ケースずつある |

明確な分類には中央値の10%＋10 µsの差に加え、CPU と GPU の四分位範囲の分離を要求する。それ以外は `ambiguous`。この分類は統計的な有意差の証明ではない。ambiguous を CPU／GPU 勝者として coverage に数えないが、許容候補と時間の検査は継続する。

regret は同時刻に全候補を実行できたという値ではなく、記録した対照中央値による推定。特に実行中の性能変化が大きいと、全期間の中央値は各選択時点の最速方式を表さない。率だけでなく raw trace・API 時間・探索費を見る。

小処理では加算許容が相対的に大きい。たとえば最終 TEA 小の auto／固定 CPU 比は約1.49倍でも、この絶対時間条件を満たす。これを「自動配置の overhead は25%以下」と言い換えない。

## チューニングで見つかった失敗

[試行1](../../../measurements/apple-m5-fit-trial1.json)は標準設定で全ケース合格。学習5件、再探索16へ変えた [試行2](../../../measurements/apple-m5-fit-trial2.json)では Merkle が失敗した。校正時の GPU 中央値は約19.6 ms、CPU 並列は約16.7 msだったが、評価時の対照は GPU 5.39 ms、CPU 12.57 msへ変化していた。

旧方策は速くなった GPU を2回試しただけで、古い観測を含む GPU 中央値は18.5 msのままだった。96件の定常 fit 率0%、推定 regret約131%、API 比2.34。学習件数を増やすだけでは追従が改善しない。

そこで以下を追加した。

- 採用中の候補の rolling median が基準から20%以上変わったら、古い観測を持つ別 processor のうち推定費用2倍以内の候補を一度再確認する。
- 代替候補の観測がそれまでの中央値より25%以上速ければ、間隔を空けずに確認する。窓9なら最大で過半数の5件を連続更新し、中央値が切替条件を満たせば通常選択へ戻る。途中の確認が速さを支持しなければ打ち切る。
- 一つの速い値で履歴を捨てない。単独／競合の確認を分離し、一時的な確認状態は GPU buffer の所有権と切り離す。

試行2を丸めた「CPU 17→12 ms／GPU 20→5.4 ms」の回帰テストは旧方策で失敗し、新方策では20回の最後8回すべて GPU になった。遅い候補が速くなった場合の連続確認、一つだけ速い外れ値、競合文脈の分離もテストした。

同じ5件／16設定の [試行3](../../../measurements/apple-m5-fit-trial3.json)では Merkle は100%になったが、compaction の定常 fit は89.0%で gate 未達。初期の負荷変化に追従するまでの誤選択と、追加探索が残った。なお試行3の Merkle は校正時から GPU が速く、実機結果だけで修正の因果効果を切り分けた実験にはなっていない。修正の回帰確認は上記の固定観測モデルでも行っている。

成功した部分だけを残さず、試行2／3は `passed: false` と全標本を保存した。CPU/GPU の周波数・他アプリ負荷は制御していない。学習5件／再探索16が常に悪いと一般化はしないが、この結果から標準値を変更する根拠もなかった。

## 最終設定を別入力で確認

修正後の標準設定を新たな評価 seed=91で測った [試行4](../../../measurements/apple-m5-fit-trial4.json)は全ケース合格。各方式96件の API p50、単位 ms。CPU 列は単一／並列の速い方。GPU は TEA 常駐と balanced histogram だけ resident、それ以外は copy 込み。

| ケース | CPU best | GPU | auto | 定常 fit |
|---|---:|---:|---:|---:|
| TEA 小 | 0.033 | 0.250 | 0.050 | 100% |
| TEA 大 | 2.994 | 1.781 | 1.749 | 100% |
| TEA 常駐 | 2.931 | 1.656 | 1.611 | 100% |
| pointer chase | 0.051 | 0.795 | 0.063 | 100% |
| compaction | 0.233 | 0.452 | 0.255 | 100% |
| hot histogram | 0.716 | 2.252 | 0.749 | 100% |
| balanced histogram | 0.952 | 1.519 | 0.993 | 100% |
| Merkle | 12.941 | 5.497 | 5.086 | 100% |

計768 auto選択のうち、定常766件はすべて許容候補。残りは histogram での GPU 探索各1件で、全選択の許容率は766/768＝約99.74%。探索を含む推定 regret の最大は TEA 小の約4.2%だった。再起動後も CPU／GPU それぞれ一ケースを別 seed で追加校正せず実行し、保存 profile の読込みを確認した。

TEA 大では GPU を選び、pointer chase と小 TEA では CPU、compaction と hot histogram では CPU 並列を選んだ。balanced histogram は試行1／3で ambiguous、試行4で CPU 優位に分類された。名前から固定配置するルールにはしない。

最終起動費は33.932 ms。学習は TEA 大59.35 ms、常駐61.36 ms、Merkle312.35 msで、API p50の表には含めていない。trainingUs は自動学習9件分で、その前の共通 warmup 3件の時間は保存していない。cold 全体の費用を測り切った値ではない。入力生成・基準結果・確保も別費用。小処理の判断と IPC の overhead、および冷えた初期計測の問題は残る。多数の仕事の同時配置や異なる機種へ、この率と時間をそのまま適用できる結果ではない。

## 次の調整に使う

```sh
just test
just validate
just bench-fit
just bench-fit --min-samples 5 --window 9 --recheck-every 16 --samples 96 --seed 91 --output build/fit-experiment.json
```

`--switch-margin`、`--block` も指定できる。block=1と4では投入間隔も変わるため、結果を同じ条件として混ぜない。評価 seed を変えると、入力の違いを使って次の設定を検証できる。追加アルゴリズムは [src/fit-cases.ts](../../../src/fit-cases.ts) に仮説とともに加え、[src/fit.ts](../../../src/fit.ts) の同じ gate を通す。失敗しても JSON を保存して非ゼロ終了する。

現時点では登録した5アルゴリズムの CPU／GPU 配置であり、任意の MSL kernel や言語プログラムの codegen、threadgroup sizeや kernel fusion の自動調整ではない。標本数と閾値を表示しながら、人が仮説を追加して実機で検証するための基盤にしている。

`just test` は56件、Metal API/GPU validation は804 GPU 実行が通過。全試行の入力 hash、学習履歴、固定対照、auto結果、方策設定、source hashes、合否を JSON に保存した。試行1／2のソースは commit `0a5489d`、試行3／4は修正後の同じ計測対象ソースで照合できる。[検証記録](<../research_notes/CPU GPU 配置の fit とチューニング/verification.md>)も参照。
