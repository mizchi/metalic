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
- `docs/internal/reports/` に統合レポート、`docs/internal/research_notes/` に出典・実験を保存する。Bend は参照元であり、別 checkout へのローカル依存を作らない。
- 利用者向け説明は本リポジトリの README と `docs/`、開発手順は `CONTRIBUTING.md`、実装・計測の詳細は `docs/internal/` に置く。explainer は説明・検証の手法として参照し、資料を別リポジトリに保存しない。`just docs-verify` は追加依存や別checkoutなしで資料の数値・図の定義・参照を検査する。
- 論文・著者解説・公開実装・提案を区別し、Metal で実証されていない性能を断定しない。
- `measurements/` は保存時点の計測。ソースを変えた後も過去の hash を書き換えず、新しい記録を作る。
- TypeScript の CPU oracle を最適化された CPU 性能 baseline として扱わない。
- アルゴリズム実験は `native/workloads*` と `src/workloads.ts`。ABI は同じ `contract.h` の `WorkloadParams` が正本。CPU の単一／GCD 並列の速い方と比べ、GPU device interval だけを全体速度にしない。
- CPU 並列 compaction は選択済み範囲の末尾を超えて書かない。分岐なしの上書きを使う場合も、次 chunk の出力を壊さない guard を保持する。
- workload の実行・資源所有は `native/workloads_runtime.h`、単発ハーネスは `native/workloads.mm`、常駐 JSONL worker は `native/workload-worker.mm`。CPU/GPU 候補でアルゴリズムや検証範囲を変えない。
- 自動配置の純粋な方策は `src/adaptive-policy.ts`、履歴の検証・atomic 保存は `src/adaptive-profile.ts`、常駐 worker 接続は `src/adaptive-worker.ts`、待ち行列・所有期間は `src/adaptive.ts`。公開型は同じ `contract.ts` に置く。
- scheduler の score は native 検証・JSON/IPC・CPU 消費を含む service wall time。自 scheduler の待ち、初回準備、校正と混ぜない。競合履歴と単独履歴を分け、GPU timestamp だけで配置を決めない。
- prepared handle は immutable replica。予約容量を入力生成より前に検査し、release／close は受理済み処理・GPU completion・CPU 消費まで待つ。worker の失敗を別 backend で隠れて再試行しない。
- プロファイルは build/MSL・機種・OS・Node・検証設定の fingerprint と TTL を検証する。raw observation を上限内で保存し、seed そのものを再利用キーにしない。複数 writer の同一 profile path はサポートしない。
- 適性対照は `src/fit-cases.ts`、評価規則は `src/fit.ts`、実機 gate は `just bench-fit`。事前の CPU/GPU ラベルや固定対照の時間を scheduler に入力しない。通常の run で学習し、別 seed の実入力 hash を確認する（全byte固定の hot histogram は明示した例外）。
- fit の定常率、探索込み regret、API 全時間を別々に報告する。小粒度の加算許容と曖昧な分類を省略しない。失敗した設定も測定記録に残し、基準を緩めて成功扱いにしない。
- drift 時の再確認は単独／競合で分離する。一観測の外れ値で履歴を置換せず、連続確認で rolling window を更新する。再確認中の一時状態は性能ヒントで、GPU buffer の所有権と結び付けない。
