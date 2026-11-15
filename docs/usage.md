# CLI と解析 API の使い方

[README](../README.md) の手順でインストールし、リポジトリのルートで `just build` を実行してから使います。ソースは UTF-8 の `.np` ファイルです。

## 式を解析する

```sh
pnpm parse examples/arithmetic.np
pnpm parse --summary examples/arithmetic.np
```

通常は token と構文木を JSON で返します。`--summary` は全構文木の代わりに、検査結果・診断・件数を返します。四則演算を解析しても、計算を実行して値を返すことはありません。

## 関数の名前と型を検査する

```sh
pnpm parse --module --summary examples/functions.np
```

`--module` は関数宣言を受け付けます。引数の未定義参照、宣言名の重複、数値演算への文字列入力、戻り値の型違いなどを検出します。対応構文と制約は [言語仕様](language.md) を参照してください。

GPU の summary は `valid`、`diagnostic`、`tokenCount`、`nodeCount`、`functionCount` を含みます。CLI は診断に名前を付け、診断があると終了コード1を返します。失敗した入力の AST は公開しません。位置は UTF-8 byte offset です。

## 複数ファイルを処理する

```sh
pnpm parse --summary examples/arithmetic.np examples/arithmetic.np
pnpm parse --module --summary --in-flight 3 examples/functions.np examples/functions.np
```

複数入力の結果は入力順の JSON 配列、単一入力は単一オブジェクトです。`--in-flight` は処理中に保持する入力数を1〜8で指定します。既定は1で、増やすと必要なメモリも増えます。

## CPU の参照実装で確認する

```sh
pnpm parse --cpu examples/arithmetic.np
pnpm parse --module --cpu examples/functions.np
```

`--cpu` は正しさを比較するための独立した参照実装を明示的に選びます。GPU が使えない場合の自動切替えではありません。CPU モードの summary は GPU summary と同一の形式ではありません。

## TypeScript から使う

ビルド後、リポジトリのルートに置いた `.ts` ファイルから実行できます。現在はソースを直接 import する実験 API です。

```ts
import { checkGpuModulesAsync } from './src/gpu.ts';

const results = await checkGpuModulesAsync([
  'fn add(x: u32, y: u32): u32 { x + y }',
]);
console.log(results.map(r => ({ valid: r.valid, diagnostic: r.diagnostic })));
```

全 token／AST を得るには `parseGpuBatch`／`parseGpuModules`、summary には `checkGpuBatch`／`checkGpuModules` を使います。summary は `checkGpuBatchAsync`／`checkGpuModulesAsync` で非同期にも呼べます。

入力は呼出し時点で確定します。返却前にアプリケーション側の document が変わった場合、結果を採用するかどうかは呼出し側で判断してください。API の型は [src/contract.ts](../src/contract.ts)、開発用オプションの説明は [開発ガイド](../CONTRIBUTING.md) から辿れます。
