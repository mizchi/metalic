# CPU GPU 協調回数の検証記録

2026-11-15。MSL 4.0、Apple M5、macOS 26.6.2。OS／Xcode の更新なし。

- Red: tests/cooperation.test.ts 追加後、未実装の frontend-feedback が存在せず ENOENT となることを確認。
- Green: 実験専用 compile flag と checkpoint を実装し、expression／module、正常／不正／UTF-8 の全 AST と診断、dispatch signature を照合した。
- `just test`: 33 passed、0 failed。
- `just validate`: 通常612＋実験34の計646実行。API/GPU validation のエラー報告なし。
- `just bench-cooperation`: 3入力形状×4間隔、各2 discarded rounds＋10標本。requestごとに一回 warmup し、二回目を記録。
- source hashes を保存後に現ソースと照合し、全ファイルが一致。

実験は CPU が GPU の意味上の判断を行わない人工的な停止である。count は読むが launch 数を変えない。kernel／scalar Params／group 数／順序の署名と最終出力が一致することを検査し、GPU の仕事量削減を混ぜない。command buffer 分割・待機・CPU読取・再発行を含む比較で、readback 単独の費用ではない。

[レポート](<../../reports/CPU GPU 協調回数の比較検証.md>)と [全標本](../../measurements/apple-m5-cooperation-trial1.json)を保存した。全標本には device 名、MSL、build flag、input hash、source hashes、checkpoint ごとの件数と時間を含む。最適化済み native CPU baseline は未実装なので CPU 比の速度向上は主張しない。

前段のバッチ比較は commit c93a97a の snapshot で、[その計測](../../measurements/apple-m5-scheduling-trial1.json)の source hashes は当該 commit で照合できる。後続の実験追加に合わせて過去の hash は書き換えない。
