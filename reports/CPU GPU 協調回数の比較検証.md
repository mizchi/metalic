# CPU GPU 協調回数の比較検証

**同じ GPU frontend の63 dispatch を、最後の待機一回で処理すると1.93 ms、毎 dispatch で CPU が count を確認して再開すると12.87 msになった。** kernel、引数、発行範囲、最終結果を揃えた比較であり、細かい CPU 協調が GPU 化の利益を消し得る懸念を、現プロトタイプでも確認できた。ただし command buffer の分割・再発行も含む実験で、readback 単独の時間や Metal の固定往復費用を計測したものではない。

2026-11-15、Apple M5／macOS 26.6.2／MSL 4.0。[バッチ実行の実装](<CPU GPU バッチ実行の比較検証.md>)に続き、一つの入力内の CPU feedback 回数を変えた。最適化した native CPU baseline や、実用コンパイラの end-to-end 比較ではない。

## 通常経路から分離した実装

`just build` は通常の `frontend-metal` と、`METALIC_FEEDBACK_EXPERIMENT=1` を定義した `frontend-feedback` を作る。通常の binary は `feedbackEvery` を受け取るとエラーにする。公開 TS API にこの制御は追加しておらず、中間 host readback を持ち込んでいない。

実験 binary は `feedbackEvery=32/8/1` で、指定数の dispatch 後、次の dispatch を発行する前に次を行う。0は途中確認なしである。

1. encoder を閉じ、command buffer を commit して完了を待つ。
2. shared control の tokenCount と nodeCount、計8 bytesを CPU で読む。
3. 同じ source／arena を使う encoder を作り、予定していた次の kernel を続ける。

count は次の launch 範囲や処理内容を変えない。CPU の判断を人工的に挟む対照実験であり、仕事量削減と同期の差を混ぜないための制約である。全 kernel 名、Params、group 数、順序の FNV-1a signature と最終出力を照合し、結果を独立した CPU oracle とも確認した。

実装は [native/feedback.h](../native/feedback.h) と [native/main.mm](../native/main.mm)、計測は [scripts/bench-cooperation.ts](../scripts/bench-cooperation.ts)、テストは [tests/cooperation.test.ts](../tests/cooperation.test.ts) にある。途中の command も lease に登録し、GPU エラーや例外が出ても使用中の arena を先に解放しない。

## 同じ仕事で待機回数を増やした結果

[全標本・入力 hash・source hashes](../measurements/apple-m5-cooperation-trial1.json)を保存した。各関数に8項の算術式を持つ1／32／256関数の module を使用。出力は同じ summary、slot数は1、buffer は selective。各 request 内で一回 warmup し、確保済み pool を使う二回目を採用した。方式の順序を回転させ、さらに2 round を破棄して10標本を保存した。

job時間は入力準備開始から CPU の summary 構築完了まで。library／process setup、最初の warmup job、JSON／IPC は含まない。GPU時間は途中と最後の command buffer の実行区間をすべて足す。実験経路の encodeUs は途中の commit／wait も含むので、CPU の encode 実働時間と解釈しない。

| 関数数 | dispatch数 | host待機1回 | 32 dispatchごとに確認 | 8 dispatchごとに確認 | 毎dispatchで確認 |
|---|---:|---:|---:|---:|---:|
| 1 | 37 | 0.981 ms | 1.588 ms・計2待機 | 3.290 ms・計5待機 | 11.573 ms・計37待機 |
| 32 | 57 | 1.516 ms | 1.594 ms・計2待機 | 4.686 ms・計8待機 | 13.156 ms・計57待機 |
| 256 | 63 | 1.931 ms | 2.227 ms・計2待機 | 4.752 ms・計8待機 | 12.869 ms・計63待機 |

256関数の内訳は次のとおり。待機数は途中確認と最後の結果待ちの合計で、途中確認だけなら0／1／7／62回になる。

| host待機数 | job p50 / p95 | GPU区間の合計 p50 | 完了後の scalar 読取累計 p50 |
|---:|---:|---:|---:|
| 1 | 1.931 / 3.259 ms | 1.530 ms | 0 µs |
| 2 | 2.227 / 3.415 ms | 1.600 ms | 0.167 µs |
| 8 | 4.752 / 6.028 ms | 2.413 ms | 0.917 µs |
| 63 | 12.869 / 17.066 ms | 0.805 ms | 1.750 µs |

返す count が小さくても、依存境界を増やすと job は遅くなる。GPU の実行区間が短い条件でも、ホストに戻って次を発行する経路が全体時間を占め得る。一方、scalar 読取は GPU 完了後に測ったもので、完了待ちも coherence の全費用も含まない。これを新しい GPU 仕事の readback 時間とは呼ばない。

別々の中央値を引いて通知時間を求めることもしていない。GPU 区間の合計が単調でないのは、分割が scheduling・cache・動作条件にも影響し得ることを示している。OS 負荷や周波数は制御しておらず、10標本の p95 は参考値。差を回数で割って一往復の普遍的な定数にする根拠はない。

## 実装判断と検証

独立な複数入力は CPU の準備・結果構築と GPU を重ね、**一つの入力の中では GPU に閉じたパス列を長く保つ**方針を継続する。ナノパスは意味論と検証の境界として残し、host へ戻る境界には固定しない。今回の8項の式の63 dispatchと、従来の32項の大モジュール計測の77 dispatchは入力が異なる。

CPU が名前や型を要素ごとに決め直す設計なら、今回の確認に加えて実際の判断時間も必要になる。逆に count による launch 縮小や早期終了があれば、協調の費用を払う利益もあり得る。それは仕事量を固定した今回とは別の比較にする。native CPU に対する損益分岐や自動配置の閾値も、この測定だけからは決められない。

`just test` は33件通過。resident／feedback の計画と AST・診断一致、通常 binary での実験制御拒否を追加した。`just validate` は通常612件＋実験34件、計646実行が通過した。実験側も複数 slot と poison memory を使って、再 encode、空入力、型・構文エラーを検査した。[検証記録](<../research_notes/CPU GPU 協調回数の比較検証/verification.md>)に手順を保存した。
