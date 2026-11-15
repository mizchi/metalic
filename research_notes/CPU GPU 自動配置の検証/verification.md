# CPU GPU 自動配置の検証記録

2026-11-15、mizchi/metalic、Apple M5／macOS 26.6.2、MSL 4.0。OS／Xcode 更新なし。

## TDD と確認した契約

純粋な policy のテストを先に追加し、未実装の Red から、候補ごとの最小観測数、待ち行列、10% margin、性能変化後の再探索、競合文脈の分離を実装した。次に native 実行系を共通 header へ切り出し、常駐 worker と scheduler を接続した。公開型を `src/contract.ts` に置き、既存 ABI は変更していない。

追加した検査は以下の11件。既存37件と合わせて48件。

- policy 5件：全候補の探索、queue による processor 変更、noise margin、drift と bounded history、競合時だけ遅い GPU の履歴分離。
- profile 1件：新規、正常、JSON 破損、fingerprint 不一致、TTL、不正な duration。
- integration 5件：通常の `run` だけでの学習、PID 継続・校正・別 seed での履歴復元、二つの lane と queue 上限・close drain、配置／実分布／メモリ予算／release、所有する idle CPU worker の障害後に queued job を拒否する動作。

最後に `just test`：TypeScript strict 検査、48/48、失敗0。テスト用 profile は一時ディレクトリで分離し、終了後に削除。

## Metal 検証

`just validate`：従来の frontend 646件、workload 92件、adaptive 12件の合計750 GPU 実行と CPU 対照が通過。

adaptive は Merkle 257葉、hot histogram 257 bytes、compact 65537要素、compact 空の4入力を保持する。各入力で GPU warmup＋校正1件、CPU/GPU 同時要求で GPU 1件の計3回。poison、logical guard、全要素照合を使う。release は先行 job の CPU 消費後。close 後に回収した worker stderr に validation error がないことも検査する。GPU の計算自体が成功しても、stderr の非致命的なエラーを見落とさないための確認である。

## 性能の範囲

`just bench-adaptive` を validation 無効で3回実行し、新規履歴で開始。試行1／2の `sourceHashes` は commit `251b136` のソースに一致。試行3は lease の所有期間のコメントと末尾空行だけを修正した後のソースに一致することを照合した。アルゴリズムや配置規則は変えていない。

- [試行1](../../measurements/apple-m5-adaptive-trial1.json)：2026-11-15 14:08:30 UTC。
- [試行2](../../measurements/apple-m5-adaptive-trial2.json)：2026-11-15 14:09:05 UTC。
- [試行3](../../measurements/apple-m5-adaptive-trial3.json)：2026-11-15 14:15:05 UTC。最終ソースの再計測。

各5ケース、候補ごとの warmup 1＋保持3で校正。固定3候補と auto を各15件、順序回転して比較。固定候補は learn=false、auto は履歴を更新。Merkle 16件の batch は3 variant ×3 round、variant 順を回転し、各 batch の前に GPU warmup 1件。連続する adaptive は履歴を持ち越すので、独立した同一初期状態の比較ではない。

`serviceUs` は RPC 開始→返信で、全 native 検証と JSON/IPC を含む。`queueUs` は同じ scheduler 内の待ち。`totalUs` はその和。benchmark の `apiUs` は公開 `run` の呼出し→await 完了で、方策判断や Promise 処理も含む。`nativeServiceUs` は native 呼出し内、`timings.elapsedUs` は元ハーネス同様に全計算＋checksum 消費までで、その後の全要素照合を含まない。`timings.gpuUs` は command buffer の GPU interval。これらを同一の時間として扱わない。

起動費は2 worker 作成・Metal 初期化・fingerprint と履歴ロードまで。準備費は入力生成・双方の CPU 基準結果・確保・初期 GPU copy を含む。校正費は warmup と保持標本すべての wall。通常の warm 表からはこれらを除外している。

OS 負荷、周波数、core placement は制御していない。最小入力の compute は16〜17 µs程度、API 全体は85〜127 µs程度で、常駐化しても IPC の相対費用が大きい。Merkle は交互実行と連続投入で GPU の時間が変わった。共有資源競合と投入間隔の効果を GPU counter で分離した実験ではない。

## 今回の境界

GPU 上の dispatch 列、CPU 単一／GCD のアルゴリズム、公開出力の意味は従来通り。共通化後も旧 workload 差分テストと validation を通した。旧 benchmark snapshot の hash は変更していない。

任意の IR の CPU/GPU codegen、affine 型の証明、入力配列の外部登録、GPU 結果 buffer の後続 job への受渡し、任意の CPU-only／GPU-only 入力移動、kernel parameter の自動調整は対象外。現在のメモリ予算は検証用 replica と scratch も含む論理予約で、RSS の厳密制限ではない。
