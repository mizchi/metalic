# アルゴリズム実験の検証記録

2026-11-15。作業先は mizchi/metalic。Bend checkout、OS、Xcode は変更していない。

## TDD と調整

- 未実装の src/workloads.ts を import するテストを追加し、ERR_MODULE_NOT_FOUND で失敗を確認した（Red）。
- MSL／native CPU、canonical ABI、CPU／GPU plan と資源所有を実装。空入力・奇数・群境界のテストを通した（Green）。
- CPU compaction を分岐なしにし、GCD chunk を最大4×CPU数へ分割。選択なしの chunk が他領域へ書かない guard を実装した。
- SHA loop 展開・histogram の SIMD 同値集約も比較し、明確な改善がなかったため GPU 版は単純な構成に戻した。
- 同じ最終ソースで試行3と4を計測し、全 source hashes の一致を確認した。

## 検査

| 実行 | 結果 |
|---|---|
| just test | build／TypeScript strict／37 tests passed |
| just validate | 既存646＋新workload92、計738 GPU実行とCPU対照。validation errorなし |
| just bench-workloads | 21入力形状×4方式。各3 warmup＋15標本。全出力の native CPU 照合 |
| Merkle の独立 oracle | Node crypto SHA256、空／単葉／奇数／多階層 |
| histogram の独立 oracle | JS のbyte逐次カウント、uniform／hot／空／端数 |
| compaction の独立 oracle | JS filter、安定順序、全選択／選択なし、65537要素で scan階層とCPU並列chunk境界 |

cooperative kernel は SIMD width 32／group 256 を実行時に確認し、全 lane が barrier に参加する。shader 側でも MSL 4.0 を compile-time に確認する。shared buffer は GPU 完了と CPU 消費後まで lease が保持し、中間 count の host readback はない。

## 保存 snapshot

- [試行1](../../measurements/apple-m5-workloads-trial1.json): commit 09e18ee。初回CPU版と単純GPU版。
- [試行2](../../measurements/apple-m5-workloads-trial2.json): commit d90e8dd。CPU改善＋GPU variant。
- [試行3](../../measurements/apple-m5-workloads-trial3.json)／[試行4](../../measurements/apple-m5-workloads-trial4.json): 最終CPU版＋単純GPU版。両者の source hashes は一致。
- [統合レポート](<../../reports/CPU GPU アルゴリズムの比較検証.md>)。

Native warm 時間は input generation、oracle生成、setup／allocation、JSON／IPC を含めない。GPU upload 方式は毎回 memcpy を含み、resident は既存GPU入力を再利用する。両方とも最終 CPU 消費を含め、単一／GCD CPU の速い方と比較する。実 CPU thread 配置や周波数は固定せず、倍率はこの実装・入力での観測値とする。
