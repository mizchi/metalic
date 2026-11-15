# CPU／GPU 配置の実験 API

これは言語の実行機能とは独立した実験です。登録した処理を native CPU 単一／並列と Metal GPU で動かし、結果を照合しながら、反復計測で実行先を選べます。

入力は件数や seed から生成します。任意の配列の登録、任意のユーザー関数のコンパイル、GPU 上の結果 buffer を別の処理へ渡す機能はまだありません。GPU を使えば必ず速くなるという保証もありません。

## 登録済みの処理

| `algorithm` | `count` の単位 | 処理 |
|---|---|---|
| `merkle-sha256` | 64-byte leafの数 | SHA-256 Merkle root |
| `histogram256` | byte数 | 256-binの集計。`distribution: 'uniform'` または `'hot'` |
| `compact-u32` | u32の数 | `(value & mask) === 0` を選び、順序を保って圧縮 |
| `tea32` | 64-bit block数 | 固定zero-keyの32-cycle整数演算 |
| `pointer-chase` | ノード数 | 一本の循環鎖の依存した読取り |

## 計測から実行先を選ぶ

`just build` 後、次をリポジトリのルートに `.ts` ファイルとして置き、`node <ファイル名>.ts` で実行できます。

```ts
import { AdaptiveScheduler } from './src/adaptive.ts';

const scheduler = await AdaptiveScheduler.open({ profilePath: 'build/profile.json' });
try {
  const input = await scheduler.prepare({ algorithm: 'tea32', count: 1048576 });
  const results = await scheduler.runBatch([input, input, input, input]);
  console.log(results.map(r => ({ mode: r.mode, verified: r.verified, totalUs: r.totalUs })));
  await scheduler.release(input);
} finally {
  await scheduler.close();
}
```

通常の `run`／`runBatch` が候補を試しながら学習します。`calibrate(input)` を呼べば、先に候補を計測することもできます。保存した履歴は互換性がある場合に次回起動で再利用します。

`prepare` は処理のない時点で呼びます。返る handle は不変の入力を表し、`release` まで資源を保持します。`close` は受理済み処理の完了と結果消費を待ち、履歴を保存します。処理中の仕事を CPU と GPU の間で移動する機能はありません。

## 入力と負荷の指定

入力の既定配置は CPU で、GPU を選んだ回は copy 込みで測ります。`prepare(spec, { inputPlacement: 'resident' })` は準備済みの GPU 入力を使う比較です。どちらの場合も CPU 側の入力を保持します。

既定の上限は準備済み8 handle、受理済み16 job、論理予約1 GiBです。`runBatch` は空きを待ち、結果を入力順に返します。直接 `run` を呼んで満杯になった場合はエラーです。論理予約量はプロセス全体の RSS の上限ではありません。

API は件数・checksum・検証結果を返し、Merkle では root も返します。単発比較用の `runWorkloads` には小入力の全出力を返す検証オプションがありますが、大きな全配列を返す汎用データ処理 API にはなっていません。

初回準備と学習にも時間がかかります。既知の最速方式より自動選択が常に速いわけではありません。API の型は [src/contract.ts](../src/contract.ts)、方式の追加や性能評価は [CONTRIBUTING](../CONTRIBUTING.md) を参照してください。
