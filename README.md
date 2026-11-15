# Metalic

> **Hobby and highly experimental.** 趣味で開発している、非常に実験的なプロジェクトです。

Apple Silicon の Metal GPU で、小さな言語の解析・名前解決・型検査を試すプロジェクトです。現在はソースを読み、解析結果や診断を JSON で返せます。

## できること

| 機能 | 現在の対応 |
|---|---|
| 式の解析 | 整数・識別子・文字列、四則演算、符号、括弧、コメントを解析し、構文木を返す |
| 関数モジュールの検査 | 明示した `u32`／`str` 型と引数を持つ関数宣言を読み、名前や型の誤りを検出する |
| 結果の取得 | 全解析結果、または診断と件数だけを JSON で取得する。複数ファイルも処理できる |
| CPU／GPU 配置の実験 | 別の実験 API で、登録済み5アルゴリズムの実行先を計測して選ぶ |

## まだできないこと

- 書いたプログラムの実行・評価や、実行ファイルの生成。
- 関数呼出し、ローカル `let`、分岐、一般的な型推論、affine 使用検査。
- 任意のユーザー関数を Metal に変換し、CPU／GPU へ自動配置すること。配置実験は登録済みの処理だけが対象。

GPU を使えば必ず速くなるわけではなく、実用コンパイラの代替として使える段階でもありません。

## 試す

GPU 実行には Apple Silicon Mac、macOS 26以降、MSL 4.0に対応する Xcode／Metal Toolchain が必要です。Node.js 24以降、pnpm、just を使います。Apple M5／macOS 26.6.2で動作確認しています。

```sh
git clone https://github.com/mizchi/metalic.git
cd metalic
pnpm install --frozen-lockfile
just build

# 式の構文を調べる
pnpm parse --summary examples/arithmetic.np

# 関数の名前・型を検査する
pnpm parse --module --summary examples/functions.np
```

## サンプルコード

[examples/functions.np](examples/functions.np) では、数値演算と文字列を返す関数の名前・型を検査できます。関数を呼び出したり、計算結果を返したりする機能はまだありません。

```text
fn add(x: u32, y: u32): u32 { x + y }
fn arithmetic(x: u32, y: u32): u32 { -(x + 1) * y + 42 }
fn identity(text: str): str { text }
fn greeting(): str { "こんにちは" }
```

TypeScript からも GPU で検査できます。次をリポジトリのルートに `sample.ts` として保存します。

```ts
import { readFileSync } from 'node:fs';
import { checkGpuModulesAsync } from './src/gpu.ts';

const source = readFileSync('examples/functions.np', 'utf8');
const [result] = await checkGpuModulesAsync([source]);
console.log(JSON.stringify({
  valid: result.valid,
  functionCount: result.functionCount,
  diagnostic: result.diagnostic,
}, null, 2));
```

ビルド後に実行すると、4関数の検査結果を取得できます。

```sh
node sample.ts
```

```json
{
  "valid": true,
  "functionCount": 4,
  "diagnostic": null
}
```

成功時は解析結果、失敗時は診断を返します。診断があれば CLI の終了コードは1です。GPU が使えない場合の自動 CPU 切替えはありません。参照用の CPU 実装は `--cpu` で明示的に選べます。

入力は1ファイル1 MiBまで、モジュールは最大256関数・各64引数です。位置情報は UTF-8 の byte offset です。

## 使い方と開発

- [CLI・解析 API の使い方](docs/usage.md)
- [対応している言語仕様](docs/language.md)
- [CPU／GPU 配置の実験 API](docs/experiments.md)
- [開発への参加・ビルド・検証](CONTRIBUTING.md)

## 参考実装

[Bend](https://github.com/bendlang/bend) を GPU 向け言語の試験実装として参照しています。Metalic は独立した試作言語で、Bend ソースのコンパイルは目標に含めません。

## ライセンス

Copyright 2026 mizchi. [Apache License 2.0](LICENSE) で公開しています。
