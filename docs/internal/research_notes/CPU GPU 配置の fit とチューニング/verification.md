# 配置 fit の検証記録

2026-11-15、mizchi/metalic、Apple M5／10 logical CPU／macOS 26.6.2、MSL 4.0。システム更新なし。

## 実装順

1. TEA32 と単一循環鎖 pointer chase の独立 Node oracle を先に追加。未登録アルゴリズムで2件 Red を確認した。
2. native CPU／MSL／dispatch plan／容量予約を追加し Green。TEA は empty、scalar tail、255／256／257、4095 block、zero vector。pointer chase は empty、1、3、境界、4097ノード、seed=0を全4候補で照合した。
3. fit 指標のテストを未実装モジュールで Red、許容候補・誤選択・曖昧な分布・探索込み regret・不正標本の判定を実装して Green。
4. `bench-fit` を実行し、標準設定の成功と強い設定の失敗を保存。古い GPU の中央値が更新されないことを確認。
5. 回帰テスト3件を追加し Red。採用候補の速度変化による再確認と、速くなった候補の連続確認を実装して Green。単独／競合の分離のテストも追加した。
6. 実機で再測定し、別 seed の標準設定を最終確認。既存の raw snapshot を書き換えていない。

## 保存試行

| snapshot | 方策 min/window/recheck/margin | 評価 seed | 結果 |
|---|---|---:|---|
| [試行1](../../../../measurements/apple-m5-fit-trial1.json) | 3/9/64/0.1 | 2271560481 | 8ケース合格、変更前の方策 |
| [試行2](../../../../measurements/apple-m5-fit-trial2.json) | 5/9/16/0.1 | 2271560481 | Merkle 不合格、変更前の方策 |
| [試行3](../../../../measurements/apple-m5-fit-trial3.json) | 5/9/16/0.1 | 2271560481 | Merkle 合格、compaction 89.0%で不合格、修正後 |
| [試行4](../../../../measurements/apple-m5-fit-trial4.json) | 3/9/64/0.1 | 91 | 8ケース合格、修正後 |

全試行とも候補と auto 各96件、block=4。warmupは各候補1回で learn=false。学習は通常の run だけを min×3件実行する。評価入力は別 seed、hot 以外は入力 hash の不一致を確認する。固定対照の評価時間を policy に observe しない。

試行1／2は commit `0a5489d` の source hashes、試行3／4は現在の計測対象 source hashes に一致。試行2／3はプロセスの exit code 1と `passed: false` を保持。基準を変更して合格へ変えていない。

## 費用と判定

fit の正解候補は対照の service 中央値から決める。API p50 は公開呼出し→await 完了で別に比較する。service に native の全結果照合・checksum消費・JSON/IPCを含む。初回起動、入力生成・CPU基準結果・GPU準備、自動学習の時間は API p50 の外で個別記録。学習時間は min×3件の run 分で、先行する共通 warmup 3件の時間は保存していない。cold 全体の費用の測定ではない。

推定 regret は選択した mode の対照中央値から計算する仮想比較で、同時に観測した最速候補の時間ではない。定常 fit から除外した探索も regret には含める。四分位分離の分類は検定ではない。小処理の API gate は `1.25×最速 +20 µs` なので比が1.25を超えても合格する場合がある。

試行2の失敗では GPU 対照 p50が5.387 msまで短くなっても、calibration 5件と疎な probe 2件の GPU 中央値は18.506 msだった。新しい方策は同じ傾向の固定コストモデルで回帰確認した。試行3の実機 Merkle は初期から GPU が速く、同じ動作条件の厳密な before/after とは扱わない。

OS 負荷、GPU 周波数、core 配置は制御していない。trial3 の compaction は開始時から対照と auto の両方が大きく変動していた。保存全期間の最速中央値がその各時点の最速を表すとは限らないため、raw trace と全時間も確認する。

## 最終チェック

- `just test`：TypeScript strict と56/56テスト、失敗0。
- `just validate`：frontend 646、workload 140、adaptive 18の計804 GPU 実行。API/GPU validation、poison、logical guard、全要素照合が通過。
- 試行4：8ケース各96 auto、定常766/766が許容候補。全体766/768、2件はGPU探索。CPU／GPU 勝者の coverage を確認。
- 過去のソース hash・計測値は不変。新しい2アルゴリズムの ABI 上限は `contract.h` から schema に生成した。

## 出典

- [Wheeler／Needham: TEA, a Tiny Encryption Algorithm](https://www.cl.cam.ac.uk/ftp/papers/djw-rmn/djw-rmn-tea.html)：32-bit word と32-cycleの演算仕様。固定 zero-key、CPU NEON、Metal 実装と測定値は本リポジトリの実験。
- 計算 dispatch・同期・保持期間は既存の `MTLCommandQueue`／shared buffer／完了待ちを維持。Metal 4専用 submissionやMSL 4.1は使用していない。
