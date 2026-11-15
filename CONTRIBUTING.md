# 開発ガイド

Metalic は実験段階です。利用可能な機能と制限は [README](README.md)、利用方法は [CLI ガイド](docs/usage.md) にまとめています。設計や性能の変更は、小さく再現できる入力とともに提案してください。

## 開発環境を用意する

GPU を動かす開発には Apple Silicon Mac、macOS 26以降、MSL 4.0に対応した Xcode／Metal Toolchain が必要です。Node.js 24以降、pnpm、just を使います。

```sh
pnpm install --frozen-lockfile
just test
```

`just test` はビルド、TypeScript の検査、CPU／GPU の差分テストを行います。GPU を使えない環境で GPU テストが成功した扱いにはしません。文書だけの検査は GPU 不要です。

```sh
just docs-verify
```

現在の実装は MSL 4.0を明示指定しています。MSL 4.1の採用案は [内部の設計資料](<docs/internal/reports/Metal GPU 言語処理系 の 設計最適化.md>) にあり、実装済み機能とは区別します。OS／Xcode の自動更新を開発手順に含めないでください。

## 変更する場所

| 場所 | 役割 |
|---|---|
| [native/](native/) | Metal kernel、native host、資源所有と同期 |
| [native/contract.h](native/contract.h) | CPU／GPU で共有する ABI、enum、上限の定義 |
| [src/contract.ts](src/contract.ts) | 公開 API の型 |
| [src/schema.ts](src/schema.ts) | `contract.h` から生成する定数。直接編集しない |
| [src/](src/) | CLI、解析 API、独立した CPU 参照実装、配置方策 |
| [tests/](tests/) | 仕様、CPU／GPU 一致、境界条件のテスト |
| [docs/](docs/) | 利用方法、対応言語、実験 API の案内 |
| [docs/internal/](docs/internal/README.md) | 実装の詳細、設計レポート、研究ノート、検証記録 |
| [measurements/](measurements/) | 保存時点のソース hash と実測標本 |

内部資料の入口は [docs/internal/README.md](docs/internal/README.md) です。パス列、診断、バッファ方式、常駐 worker、計測区間の説明は [実装と計測の詳細](docs/internal/implementation.md) を参照してください。

## 変更と検証の進め方

探索 → 失敗する再現例（Red）→ 最小の実装（Green）→ 整理、の順で進めます。CPU 参照実装は GPU の処理手順をそのまま複製せず、独立に結果を確認できるものを使ってください。

| 変更 | 実行する確認 |
|---|---|
| 文書・リンク・保存データの説明 | `just docs-verify` |
| 言語仕様・TypeScript・native 実装 | `just test` |
| GPU kernel、レイアウト、同期、再利用 | `just test` と `just validate` |
| 性能改善 | 上記で正しさを確認後、該当する `just bench-*` |

ABI を変える場合は `native/contract.h` を編集し、`just build` で `src/schema.ts` を再生成します。生成元と生成結果を同じ変更に含め、host と shader のサイズ・offset の一致も確認してください。

GPU に関する変更では、空入力、1要素、group境界の前後、長い入力の後の短い入力、異常入力を確認します。再利用・初期化の変更は `poisonBuffers: true` で未初期化の読み出しと範囲外書込みを調べます。

維持する重要な規則は次の通りです。

- buffer は GPU 完了と CPU の結果消費の両方が終わるまで保持する。完了通知だけで slot を再利用しない。
- 通常の GPU frontend に中間 count の host readback や暗黙の CPU parser fallback を追加しない。
- エラー時の未検証 AST を公開せず、診断の優先順位と UTF-8 byte offset を維持する。
- CPU／GPU の配置方策、実行状態、資源所有、公開型を分離する。

## 性能を比較する

既存タスクは `just --list` で確認できます。

| タスク | 比較するもの |
|---|---|
| `just bench` | frontend の基本測定 |
| `just bench-diagnostics` | 診断の集約方式 |
| `just bench-buffers` | 確保・再利用・初期化 |
| `just bench-scheduling` | 独立入力の同時実行と full／summary 出力 |
| `just bench-cooperation` | 実験専用 binary での CPU 協調回数 |
| `just bench-workloads` | native CPU と GPU のアルゴリズム比較 |
| `just bench-adaptive` | 配置学習、履歴再利用、queue |
| `just bench-fit` | 適性の異なる対照での配置精度と費用 |

validation は正しさの検査に使い、速度測定では無効にします。CPU は単一／GCD の速い方を対照にし、TypeScript oracle を最適化済みの CPU baseline と扱わないでください。GPU 内部の時間、CPU 消費・JSON／IPCを含む時間、初回準備、学習費用を区別します。

`measurements/` の過去の値や source hashes は書き換えません。ソースや条件を変えたら新しい記録を保存し、成功した設定だけでなく失敗した比較も残してください。fit の許容幅と探索費用は [評価レポート](<docs/internal/reports/CPU GPU 配置の fit とチューニング.md>) に記載しています。

## 文書の置き場所

README には利用者が試せる機能、制限、最短の使い方を置きます。内部のアルゴリズム、設計上の案、測定手順、研究上の比較は `docs/internal/` に追加し、その [目次](docs/internal/README.md) から参照できるようにします。

文書を移したら相対リンク、画像、再現コマンドも更新し、`just docs-verify` を実行してください。固定commitへの引用と過去の測定データは、保存時点の参照として保持します。

## 変更を送る

PR には、変えた挙動、再現入力、確認したコマンド、残る制約を記載してください。性能を主張する場合は環境・入力・出力仕様・測定範囲・新しい保存記録を添えます。実装していない案と、実行して確認した結果を区別します。
