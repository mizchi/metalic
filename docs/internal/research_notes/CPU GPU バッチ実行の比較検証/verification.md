# CPU GPU バッチ実行の検証記録

2026-11-15。リポジトリは `mizchi/metalic`。Bend checkout は変更していない。

## TDD と契約

- 既存の同期 driver、BufferLease、公開 API、buffer test を確認。
- `tests/scheduling.test.ts` を追加し、未実装の `checkGpuBatch` export がないため失敗することを確認（Red）。
- bounded FIFO、所有する future、summary、公開 API を実装して差分・所有期間テストを通した（Green）。
- GPU timestamp による区間をテストへ追加し、未実装の timestamp が原因で失敗することを確認。GPU の host-clock start/end を追加して通過。
- 非同期 API と入力 snapshot、native protocol の境界、発行後の例外を追加確認。
- scheduler と future を別 header に整理し、全体検査を再実行した。

## 最終チェック

| コマンド | 結果 |
|---|---|
| `just test` | build / TypeScript strict / 31 tests passed |
| `just validate` | 612 executions、Metal API/GPU validation のエラーなし |
| `node src/cli.ts --module --summary --in-flight 3 examples/functions.np examples/functions.np` | 2結果、診断なし、AST 配列のない summary |
| `just bench-scheduling` | 3入力形状×2出力×3 slot数、各2 warmup＋10標本、全出力を oracle と照合 |
| 保存した計測の SHA-256 照合 | `sourceHashes` の全ファイルが現ソースと一致 |

入力ごとに GPU pass 内の中間 host readback はない。completion handler は通知だけを行い、pool の返却は CPU 消費後。例外時の test は一件を発行した後に不正な次入力を検出し、GPU を待つ destructor 経由でエラー終了する。未完成の結果は stdout に出さない。

## 保存物と限界

- [統合レポート](<../../reports/CPU GPU バッチ実行の比較検証.md>)。
- [計測全標本](../../../../measurements/apple-m5-scheduling-trial1.json)。source hashes、入力 hash、stage time、全 flight trace を含む。
- 比較スクリプトは `scripts/bench-scheduling.ts`。同一出力契約の中で slot数を比較する。
- 各 trial は新 process／library・空 pool。native batch に初期確保を含め、setup／JSON／IPC は API 時間へ分ける。
- 最適化した native CPU baseline、自動配置、公開 IR handle、常駐 worker は未実装。旧計測の hash は書き換えていない。
- MSL 4.0。OS／Xcode 更新は実行していない。
