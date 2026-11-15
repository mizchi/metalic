# Metalic

ユーザーには日本語で答える。

## 開発

- 探索 → Red → Green → Refactoring の順で開発する。
- タスクは `justfile`、Node.js は24以降、依存管理は pnpm を使う。
- `just test` でビルド・TypeScript 検査・CPU/GPU 差分テストを実行する。
- GPU kernel や同期を変更したら `just validate` で Metal API/GPU validation も確認する。
- 既存のユーザー作業を保持し、無関係な変更はしない。

## 設計とコントラクト

- ABI と enum の正本は `native/contract.h`。`src/schema.ts` は生成物。
- 公開 API は `src/contract.ts`。状態とロジック、論理パスと物理 dispatch を分離する。
- GPU 経路に CPU parser の暗黙 fallback や中間 count の host readback を追加しない。
- 強制 host feedback の比較は `METALIC_FEEDBACK_EXPERIMENT` を付けた `frontend-feedback` のみに隔離する。通常の `frontend-metal` は `feedbackEvery` を拒否する。比較時は dispatch signature と最終結果を揃え、count で launch 範囲を変えない。
- span は UTF-8 byte offset。エラー時に未検証の AST を公開しない。
- 構文・名前・型の診断優先順位と同一段階での最小 byte/code を維持する。
- バッファ等の資源は GPU completion まで保持し、再利用は完了後に行う。
- pool の lease は GPU 完了と CPU の結果構築が終わるまで返さない。選択的初期化を変更したら `poisonBuffers: true` で layout・入力長・成功/失敗を切り替え、未初期化読み取りを検査する。
- 独立入力の CPU スケジュールは `native/batch.h`、完了通知と所有権は `native/flight.h` に置く。completion handler は通知だけを行い、pool slot を返さない。例外時も pending flight を待ってから Runtime を破棄する。
- `maxInFlight` は1〜8（既定1）。同じ slot の次入力準備は前入力の CPU 消費後に限る。summary API は検査済み件数と診断を返し、エラー時の node/function 件数は0とする。

## 環境とリサーチ

- 当面は MSL 4.0／M5／macOS 26.6.2 の環境で検証を続ける。MSL 4.1 への移行は後回しとし、特定の検証で必須になる場合は理由をユーザーへ報告する。
- OS／Xcode 更新はユーザーが後で行う方針。移行作業の一環でシステム更新を実行しない。
- `reports/` に統合レポート、`research_notes/` に出典・実験を保存する。Bend は参照元であり、別 checkout へのローカル依存を作らない。
- 論文・著者解説・公開実装・提案を区別し、Metal で実証されていない性能を断定しない。
- `measurements/` は保存時点の計測。ソースを変えた後も過去の hash を書き換えず、新しい記録を作る。
- TypeScript の CPU oracle を最適化された CPU 性能 baseline として扱わない。
