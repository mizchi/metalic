# 内部実装・研究・計測資料

開発者向けの資料です。利用方法は [CLI ガイド](../usage.md)、実装を変更する手順は [CONTRIBUTING](../../CONTRIBUTING.md) を参照してください。

## 実装を読む

- [実装・API・計測の詳細](implementation.md)：パス、診断、バッファ、非同期処理、配置学習と計測区間。
- [Metal で言語を作って分かったこと](metalic-lessons/README.md)：実測から変わった設計判断。図・保存データの再集計付き。
- [知見の説明資料の検証記録](metalic-lessons/verification.md)：何を再検査できるかと、その範囲。

## 設計と調査

- [Metal 向けコンパイラと実行基盤](<reports/Metal 向け コンパイラ と 実行基盤.md>)：Bend／Mojo、Metal の制約、関連研究。
- [言語処理系のナノパス設計](<reports/Metal 言語処理系 の ナノパス設計.md>)：段階ごとの入力と出力。
- [GPU 言語処理系の設計最適化](<reports/Metal GPU 言語処理系 の 設計最適化.md>)：MSL 4.1も含む将来案。現行のMSL 4.0実装と区別する。
- [CPU／GPU 協調の実ワークロード評価](<reports/CPU GPU 協調 の 実ワークロード評価.md>)：状態管理、feedback、直列部分の検討。

## 実装と比較の記録

- [診断集約](reports/診断集約の比較検証.md)
- [バッファ再利用](reports/バッファ再利用の比較検証.md)
- [CPU／GPU バッチ実行](<reports/CPU GPU バッチ実行の比較検証.md>)
- [CPU／GPU 協調回数](<reports/CPU GPU 協調回数の比較検証.md>)
- [アルゴリズム比較](<reports/CPU GPU アルゴリズムの比較検証.md>)
- [自動配置](<reports/CPU GPU 自動配置の検証.md>)
- [配置の fit とチューニング](<reports/CPU GPU 配置の fit とチューニング.md>)

各レポートは実装・測定した時点の記録です。現在の機能を判断する場合は [README](../../README.md) と実装を確認してください。

詳細な出典・小実験・検証手順は [research_notes](research_notes/) にあります。元の測定標本は来歴を保つため [measurements](../../measurements/) に保持し、過去の値や source hashes は書き換えません。固定commitへの引用も保存時点の参照として残します。
