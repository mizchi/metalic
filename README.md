# Metalic

UTF-8 ソースからトークン列と flat AST を **Metal GPU 上で構築する**、macOS 専用の小さなフロントエンド。関数モジュールでは引数の名前解決と `u32`／`str` の型検査も GPU で行う。Node.js は入力と最終結果の表示、Objective-C++ はバッファ確保とコマンド発行を担当する。GPU 経路は CPU パーサを呼ばない。Bend を参考にした独立の実験言語であり、Bend ソースをコンパイルするものではない。

Bend 内で作成した試作とリサーチを `mizchi/metalic` に切り出した。Bend の checkout や runtime はビルド・実行に不要。

```sh
git clone https://github.com/mizchi/metalic.git
cd metalic
pnpm install --frozen-lockfile
just test
pnpm parse --summary examples/arithmetic.np
pnpm parse --module --summary examples/functions.np
just parse examples/arithmetic.np
just module examples/functions.np
just validate
just bench
just bench-diagnostics
just bench-buffers
```

必要環境は Apple Silicon の Metal GPU、macOS 26以降、対応 Xcode／Metal Toolchain、Node.js 24+、pnpm、just。MSL 4.0 を明示指定し、Apple M5 / macOS 26.6.2 で動作確認した。実行時依存の npm ライブラリはなく、TypeScript と Node の型定義は検査用の開発依存。

**MSL 4.1 の採用と OS／Xcode の更新は後回しにし、当面は4.0で検証する。** 最新 MSL を使う将来の [v2 設計案](<reports/Metal GPU 言語処理系 の 設計最適化.md>)と、現在の [診断集約の比較検証](reports/診断集約の比較検証.md)を分けて記録する。4.1固有の機能が必要になる検証は、その時点で要件を確認する。

## 実装とリサーチ

| 場所 | 内容 |
|---|---|
| [`native/`](native/) | Metal kernels、Objective-C++ の host、共通 ABI |
| [`src/`](src/) | 公開 API、CLI、独立した CPU 参照実装 |
| [`tests/`](tests/) | CPU/GPU の差分テスト |
| [`examples/`](examples/) | 式・関数モジュールのサンプル |
| [`measurements/`](measurements/) | 実装の hash と保存済み計測値 |
| [`reports/`](reports/) | 調査を統合した設計レポート |
| [`research_notes/`](research_notes/) | 出典、調査ノート、小実験・計測記録 |

レポートは以下の順に読める。最新の採用方針は v2 設計案に置く。

1. [Metal 向け コンパイラ と 実行基盤](<reports/Metal 向け コンパイラ と 実行基盤.md>) — Bend／Mojo、Metal の制約と同期、関連研究。
2. [Metal 言語処理系 の ナノパス設計](<reports/Metal 言語処理系 の ナノパス設計.md>) — Chez／Harlan 等を参考にした段階契約。
3. [Metal GPU 言語処理系 の 設計最適化](<reports/Metal GPU 言語処理系 の 設計最適化.md>) — 2024–2026年の研究、現行の費用、MSL 4.1 を基準にした v2。
4. [診断集約の比較検証](reports/診断集約の比較検証.md) — MSL 4.0で3方式を実装・照合し、発行回数と処理時間を比較。
5. [バッファ再利用の比較検証](reports/バッファ再利用の比較検証.md) — バッファの再利用・初期化範囲・区間別時間を検証。
6. [CPU GPU 協調 の 実ワークロード評価](<reports/CPU GPU 協調 の 実ワークロード評価.md>) — 状態を CPU に保つ設計を、必須 feedback・アムダールの法則・実ワークロードから評価。
7. [CPU GPU バッチ実行の比較検証](<reports/CPU GPU バッチ実行の比較検証.md>) — 複数 slot の所有期間、非同期 API、全 AST／summary の計測。
8. [CPU GPU 協調回数の比較検証](<reports/CPU GPU 協調回数の比較検証.md>) — 同じ kernel 列へ強制 feedback を挿入し、依存境界の費用を検証。
9. [CPU GPU アルゴリズムの比較検証](<reports/CPU GPU アルゴリズムの比較検証.md>) — SHA-256 Merkle、histogram、安定圧縮を native CPU と実測比較。
10. [CPU GPU 自動配置の検証](<reports/CPU GPU 自動配置の検証.md>) — 常駐 scheduler、反復計測による配置学習、保存と再探索、初回費用と競合。
11. [CPU GPU 配置の fit とチューニング](<reports/CPU GPU 配置の fit とチューニング.md>) — GPU／CPU 向きの対照、別入力の評価 gate、古い校正の回帰と再確認。

`pnpm parse --cpu file.np` は独立した CPU oracle を明示的に使う。`--module --cpu` では関数モジュールの oracle を使う。GPU が使えない場合はエラーにし、暗黙の CPU fallback はしない。`--chunk-size 7` などで字句チャンクを変更できる。

診断集約は `--diagnostics packed`（既定）、`hierarchical`、`tree` で切り替える。TS API では第4引数に `{diagnostics: 'tree'}` 等を渡せる。結果の `mslVersion` は shader が報告した言語バージョン、`diagnosticDispatches` は診断専用 dispatch の件数を表す。

`--buffers fresh|reuse|selective` または TS API の第4引数 `{buffers: 'selective'}` 等で、毎回確保、再利用と全初期化、再利用と必要な列だけの初期化を比較できる。既定は `selective`。frontend の再利用は一つの native request 内の複数入力・反復が対象。API 呼出し間の常駐 worker は、後述のアルゴリズム scheduler のみ実装済み。`timingsUs` は準備・確保・初期化・発行・commit/wait・結果オブジェクト構築の区間を持ち、`bufferAllocations` はその回の Metal buffer 確保数、`initializedBytes` は arena 初期化の CPU 書き込み量を表す。`poisonBuffers: true` は初期化漏れの検証用で、計測時は無効にする。

独立入力を重ねるには `{maxInFlight: 3}` を指定する（1〜8、既定1）。CPU は別 slot の準備・encode、GPU は発行済み入力、CPU は完了した別入力の結果構築を進める。`native/batch.h` が FIFO と出力順を管理し、`native/flight.h` の future が source／arena を保持する。GPU の completion handler は semaphore を通知するだけで、slot の再利用は CPU の結果構築後に行う。例外時も発行済み GPU 処理を待ってから解放する。slot を増やす分だけ保持容量も増える。

`parseGpuBatch`／`parseGpuModules` は全 AST を返す。`checkGpuBatch`／`checkGpuModules` は同じ GPU pass 列を実行し、`valid`、診断、token／node／function 件数だけ返す。失敗時は node／function 件数0とし、未検証 AST は公開しない。`checkGpuBatchAsync`／`checkGpuModulesAsync` は Promise を返すので、Node 側の I/O や他の状態処理も進められる。入力は呼出し時に JSON snapshot として確定するが、結果の版を検証して採用する責任は呼出し側にある。各呼出しで native process を作る点は共通である。

```ts
import { checkGpuModulesAsync } from './src/gpu.ts';
const future = checkGpuModulesAsync(sources, 64, 1, { maxInFlight: 3 });
// 独立した I/O や次 batch の準備を進める
const results = await future;
```

CLI も複数ファイルを受け付ける。`pnpm parse --module --summary --in-flight 3 a.np b.np` は GPU の summary を返し、全 AST の CPU 展開を省く。一ファイルなら従来どおり単一オブジェクト、複数なら入力順の配列になる。

`batch.wallUs` は native の最初の入力準備から全結果の構築までで、setup と JSON／IPC を含まない。`batch.peakLeasedSlots` は CPU 消費待ちを含む slot 数で、同時に演算中の GPU 数ではない。`batch.peakBufferBytes` は保持する Metal source／arena の合計容量で RSS ではない。`flightSamples` は準備・submit・GPU 時刻・完了通知・CPU 消費の timeline を持つ。複数 slot の `elapsedUs`／`submitWaitUs` には他入力の CPU 作業中の経過時間も含むため、入力ごとの値を合計して batch 時間にしない。`completionWaitUs` は通知を待ったホスト時間で、readback 固有の費用ではない。

`just bench-buffers` は7ケース×3方式を同じ process／library で比較し、結果を `build/buffers-benchmark.json` に保存する。[試行1](measurements/apple-m5-buffers-trial1.json)・[試行2](measurements/apple-m5-buffers-trial2.json)に source hashes と全標本を保存した。大モジュールの初期化書込み量は約13.34→1.56 MBに減ったが、pool は2の冪へ丸めた最大容量を保持する。処理時間・確保容量・初期化量は分けて扱う。

`just bench-cooperation` は実験専用の `build/frontend-feedback` を使い、同じ kernel 列を32／8／1 dispatchごとに区切って CPU で2件の count を読んでから再開する。0は途中確認なし。kernel・引数・発行範囲の signature と最終出力を照合し、count によって発行量を変えない。通常の `frontend-metal` はこの制御を拒否する。[協調回数の計測](measurements/apple-m5-cooperation-trial1.json)を保存した。command buffer 分割・再発行・GPU scheduling も変わる比較であり、readback 単独の費用や普遍的な往復時間とは扱わない。

## アルゴリズムの CPU／GPU 比較

`just bench-workloads` は SHA-256 Merkle 木、256-bin ヒストグラム、u32 安定圧縮を、native CPU 単一／GCD 並列、GPU 常駐／コピー込みの4方式で測る。CPU は CommonCrypto、private histogram、分岐なし compaction を使う。GPU は同じ全結果を生成し、完了後の CPU 消費まで計る。入力生成・検証・初期確保・library setup・JSON は warm 時間の外。これは生成入力の実験ハーネスで、言語からの自動 GPU 化ではない。

```ts
import { runWorkloads } from './src/workloads.ts';
const experiment = runWorkloads([
  { algorithm: 'merkle-sha256', count: 262144 },
  { algorithm: 'histogram256', count: 16777216, distribution: 'uniform' },
  { algorithm: 'compact-u32', count: 1048576, mask: 1 },
], { warmups: 3, samples: 15 });
```

`WorkloadParams` と上限は native/contract.h が正本。GPU kernel は native/workloads.metal、CPU は native/workloads_cpu.h。全結果を計測後に照合し、debug の poisonBuffers では source／arena の logical guard も確認する。includeOutput は小入力の全配列を返す検証用で、compaction は8192要素以下に限る。cpuTasks は GCD chunk 数で物理コア数ではない。

最終 native／MSL の [試行3](measurements/apple-m5-workloads-trial3.json)・[試行4](measurements/apple-m5-workloads-trial4.json)と、API入口修正後の [試行5](measurements/apple-m5-workloads-trial5.json)を保存した。大きな Merkle は GPU の利益を確認し、histogram は常駐・分布次第、最適化後の compaction は CPU が速かった。[比較レポート](<reports/CPU GPU アルゴリズムの比較検証.md>)に条件と限界を記載した。

## 実測で CPU／GPU を選ぶ

`AdaptiveScheduler` は登録済みの5アルゴリズムを対象に、CPU 単一／GCD 並列と GPU を繰り返し計測して選ぶ。CPU と GPU の native worker を一つずつ常駐させ、独立した仕事を並行実行する。`run` を繰り返すだけで各候補を既定3回ずつ試し、以後は直近の中央値と待ち行列から配置を決める。明示的な `calibrate` は、候補ごとの warmup を除外して先に学習する API。

```ts
import { AdaptiveScheduler } from './src/adaptive.ts';
const scheduler = await AdaptiveScheduler.open({ profilePath: 'build/profile.json' });
try {
  const input = await scheduler.prepare({ algorithm: 'merkle-sha256', count: 262144 });
  await scheduler.calibrate(input); // 任意。通常の run も学習する
  const results = await scheduler.runBatch([input, input, input, input]);
  console.log(results.map(r => [r.mode, r.decision.reason, r.totalUs]));
  await scheduler.release(input);
} finally {
  await scheduler.close(); // 受理済みの仕事と GPU 完了・CPU 消費を待ち、プロファイルを保存
}
```

入力は生成レシピから作る immutable handle。`prepare` は idle 時に呼ぶ。CPU/GPU 両方の入力・scratch・検証用基準結果を保持し、入力生成と基準結果の計算は `prepareUs` に含める。`inputPlacement: 'cpu'`（既定）の GPU 候補は毎回の copy 込み。`prepare(spec, {inputPlacement: 'resident'})` は準備済み GPU 入力を使い、CPU replica も保持する。任意の外部配列や GPU-only buffer の移送にはまだ対応しない。

履歴は非競合／競合それぞれ直近9件、切替えには既定10%の改善を要求する。64回ごとを再探索の機会とし、遅い候補ほど間隔を延ばす。`contended` は CPU/GPU の RPC 実行期間の重なりを表す。プロファイルは処理種類・件数・実際の分布の特徴・入力配置ごとに保存し、別 seed でも同じ形状なら再利用する。binary・MSL・scheduler ソース・機種・OS・Node・検証設定が変わると無効化し、既定24時間で観測を失効させる。保存は atomic rename。一つの profile path を複数インスタンスから同時に書かない。

既定上限は受理済み16件、準備済み8 handle、論理予約1 GiB。`runBatch` は上限まで投入して空きを待ち、入力順で結果を返す。直接の `run` が満杯ならエラー。`release` はその handle の受理済み処理を待つ。worker／GPU エラー時は未実行分も失敗させ、別 backend で隠れて再試行しない。既定の履歴ファイルは `build/adaptive-profile.json`。`flush` と `close` で保存を待てる。

学習の `serviceUs` は native の全結果照合、JSON／IPC、CPU 消費を含む。`queueUs` は自 scheduler 内の待ち、`totalUs` はその和、`nativeServiceUs` と `timings` は内訳。初回起動・準備・校正は別に報告する。既知の最速方式より必ず速くなる保証はなく、約16 µsの小処理では IPC／判断費が目立つ。`just bench-adaptive` の [試行1](measurements/apple-m5-adaptive-trial1.json)・[試行2](measurements/apple-m5-adaptive-trial2.json)・[試行3](measurements/apple-m5-adaptive-trial3.json)では、大 compaction は CPU、Merkle はその時点の実測に応じ CPU／GPU を選んだ。Merkle の連続投入での並行実行の利益は試行間で変わり、常に高速化する結果にはなっていない。

これは登録した純粋な処理の配置最適化。言語 frontend の自動 CPU 化、任意関数の GPU コード生成、kernel fusion／JIT、実行途中の移動は未実装。

## 配置が fit することを検査する

`just bench-fit` は、大きい TEA32／Merkle、小さい TEA32、単一鎖の pointer chase、compaction、uniform／hot histogram の8ケースで配置を検査する。TEA32 は固定 zero-key の32-cycle整数演算で、CPU は4 block の NEON＋GCD、GPU は block ごとに並列化する。pointer chase は全ノードを通る一本の循環鎖で、次アドレスが直前の load に依存する。CPU 並列指定でも、この依存を省略しない。

```sh
just bench-fit
# 校正数・履歴窓・再探索間隔・切替え幅・評価入力を変え、結果を別名で保存
just bench-fit --min-samples 5 --window 9 --recheck-every 16 --switch-margin 0.1 --seed 91 --output build/fit-experiment.json
```

学習は通常の `run` だけで行う。評価は別 seed の入力を使い、固定 CPU/GPU 対照は `learn: false` で学習に入れない。全byte同値の hot histogram は seed を変えても同じ入力になる例外。各候補と auto を4件ずつの回転順で各96件測る。分類は実測で決め、CPU／GPU 向きという事前ラベルを scheduler へ渡さない。

gate は、許容候補（最小 service 中央値の1.1倍＋10 µs以内）への定常選択率90%以上、探索込みの推定 regret 15%以下、API 中央値が最速固定候補の1.25倍＋20 µs以内を要求する。CPU／GPU 両方の明確な実測勝者も必要。四分位範囲が重なる場合などは ambiguous と記録する。失敗時も JSON を保存して非ゼロ終了する。既定出力は `build/fit-benchmark.json`、明示した `--output` は既存ファイルを上書きしない。

標準設定の最終 [試行4](measurements/apple-m5-fit-trial4.json)は8ケース合格、探索を除く766/766件が許容候補だった。[試行2](measurements/apple-m5-fit-trial2.json)の古い GPU 校正から復帰できない失敗、修正後も積極的な設定が compaction で基準未達だった [試行3](measurements/apple-m5-fit-trial3.json)も保存した。標準値は3標本・窓9・再探索64・margin 10%を維持する。

再探索に加え、採用中の費用が20%以上変われば推定費用2倍以内の別 processor を再確認し、代替候補が25%以上速くなった観測には連続確認を行う。一つの外れ値で履歴を捨てず、窓の過半数を更新する。詳細な gate と制約は [fit レポート](<reports/CPU GPU 配置の fit とチューニング.md>)を参照。配置が正しくても小処理の IPC／判断費は残り、単一鎖という条件を多数の独立鎖に一般化しない。

## 現在の言語範囲

```ebnf
program = expr, { ";", expr }, [ ";" ];
expr    = product, { ("+" | "-"), product };
product = prefix, { ("*" | "/"), prefix };
prefix  = { "+" | "-" }, atom;
atom    = uint32 | identifier | string | "(", expr, ")";
```

整数は十進 u32、識別子は ASCII の英字・数字・アンダースコア。文字列内は UTF-8 と escaped byte を保持し、内容の評価は行わない。文字列内の非 escape 改行は拒否する。`//` コメントは CR/LF で終了し、`/* */` は入れ子にしない。空の式プログラムは `EExpectedOperand`。位置は常に UTF-8 **byte offset**。

二項演算は左結合、prefix 演算は右結合。式モードでは `;` は `NSequence` にし、名前解決・型検査をせずに構文として AST に残す。

`--module` は次の宣言文法を明示的に選ぶ。

```ebnf
module    = function, { function };
function  = "fn", identifier, "(", [ parameter, { ",", parameter } ], ")",
            ":", type, "{", expr, [ ";" ], "}";
parameter = identifier, ":", type;
type      = "u32" | "str";
```

```text
fn add(x: u32, y: u32): u32 { x + y }
fn identity(text: str): str { text }
```

各関数は独立した引数スコープを持つ。関数名の重複、同一関数内の引数名の重複、未定義名、数値演算への `str` の入力、戻り値の型の不一致を拒否する。演算子の出力は `u32` と決まっているため、この型系の検査は型の初期化と各ノードの局所検査で完了する。一般の型推論や依存型検査の並列化を実現したものではない。`fn` はモジュールモードのみの予約語。上限は256関数、各64引数で、超過は GPU の診断になる。

関数呼び出し、ローカル `let`、分岐、型推論、affine 使用検査、ユーザープログラムの評価・コード生成は未実装。

## パスとコントラクト

| パス | 入力から出力 | 主な保証 |
|---|---|---|
| Lex | Source → LexemeFlags | チャンクの入口状態、開始・終了 flag、字句エラー |
| Tokenize | LexemeFlags → TokenIR | prefix scan と scatter による kind/begin/end の密な列 |
| Structure | TokenIR → StructuredTokens | 括弧深度、token 隣接規則、文法エラー |
| NormalizeOperators | StructuredTokens → OperatorIR | prefix/binary の区別、優先順位、ノードの密な列 |
| BuildAst | OperatorIR → RawAst | parent/left/right の Cartesian tree |
| ValidateAst | RawAst → CheckedAst | arity と親子関係、最初の診断 |
| ResolveNames（module） | CheckedAst → ResolvedAst | 宣言の一意性、引数への binding ID |
| CheckTypes（module） | ResolvedAst → TypedAst | primitive 型、演算の入力型、戻り値型 |

[`native/contract.h`](native/contract.h) が ABI と enum の正本。`scripts/generate.mjs` は TypeScript の enum 定数を生成する。[`src/contract.ts`](src/contract.ts) が公開結果型で、`native/passes.h` の移動専用パストークンが予約順と入力の再使用を検査する。予約済みの状態と GPU 完了は区別し、結果は完了後にだけ読む。これは Nanopass の段階契約を参考にした手書きの構成で、Scheme Nanopass Framework を GPU 上で動かしたものではない。

中間データは各入力の shared arena 内の SoA 列に保持する。トークン・ノードの **容量**をソース byte 数で抑え、**論理件数**は GPU control buffer に置く。各 dispatch は容量を上界とし、GPU が件数で guard する。中間件数の CPU readback、トークンごとの CPU callback はない。各入力につき一つの command buffer と最後の完了通知待ち一回で処理する。command buffer と future の資源保持を、GPU 完了と CPU 消費の両方が終わるまで維持する。

最終結果を JSON に dump するため CPU が列を読む。外部 API へ長寿命の GPU バッファ handle を返す機能は未実装。入力上限は一つにつき 1 MiB。すべてを shared にしてあり、storage mode の最適化や Metal 4 専用 API はまだ比較していない。

## GPU アルゴリズム

字句解析は9状態の DFA。各チャンクが **すべての入口状態に対する遷移関数**を作り、関数合成の prefix scan で実際の入口状態を求める。その後に token 開始・終了 flag を出す。状態関数をベクトルで保持するため、遷移モノイドの ID と巨大な合成表を生成する必要はない。チャンク間の prefix は Hillis–Steele、整数列は256スレッドの局所 scan＋再帰的 group scan を使う。

構文解析は今回の固定式文法に特化する。token の隣接規則と括弧深度が文法を検査し、`(depth, precedence, associativity/index)` の全順序から Cartesian tree を構築する。range-minimum segment tree を作り、各ノードが nearest-smaller neighbor を O(log capacity) で探す。各ノードを一つの GPU スレッドが処理し、一つのスレッドで全体を逐次 parse する実装ではない。

関数モジュールでは `fn` の位置を scan/scatter し、逆向きの minimum scan で次の閉じ波括弧を索引する。宣言ヘッダは各関数に一つの GPU スレッドを割り当て、最大64引数を逐次処理する。本体の字句・構文解析はノードごとに並列のまま。Cartesian tree の探索範囲を関数本体に限定し、関数ごとの root を作る。名前解決は各参照が自分の引数表を探索する。関数名の重複確認は先行する最大255宣言、引数名の重複確認は最大63引数との比較で、ハッシュ表はまだ導入していない。

一般文法を扱う LLP parser generator は未実装。この固定文法で成立する検査を、任意の LL/LR 文法やブロック構文へそのまま広げてはいけない。Pareas の DFA/scan と構造の合成を参照している。

AST の NodeId は本体の括弧等を除いた token 順。node span はそのノードを定義する **token の範囲**であり、部分木全体の範囲ではない。親子列は NodeId、未接続は `null`。文字列や識別子は token span から元ソースを参照する。モジュールの各ノードは宣言順の `functionId`、引数名の TokenId を使う `binding`（非参照は `null`）、`type` を持つ。`functions` には関数名の span、引数列、戻り値型、本体の NodeId を返す。モジュール全体の `root` は `null`。

エラー時は AST・関数表を公開せず、`nodes: []`、`functions: []`（module）、`root: null` を返す。診断は構文・名前・型の順に検査し、エラーのある段階で最小 byte offset、同位置では error code 順の一件を返す。同じ EOF への並行診断には atomic 操作を使う。複数エラーの回復処理は含まない。

## 検証と計測

`just test` は ABI 生成・ビルド、TypeScript strict 検査、56本のテストを実行する。優先順位・左結合・右結合 prefix、2048個の prefix、深い括弧、長い識別子、文字列・コメント、64通りの alignment、4種類の chunk size、固定 seed の生成式、不正入力の挿入、80,001ノードでの3階層 group scan を照合する。モジュールは独立スコープ、型エラー、204通りの宣言破壊、関数・引数の上限、深さの異なる128関数の式木を確認する。CPU oracle は逐次 byte lexer＋反復 shunting-yard と逐次の宣言・型検査で、GPU の遷移関数 scan／Cartesian tree を再利用していない。

`just validate` は Metal API/GPU validation を有効にして式4件・モジュール13件を診断3方式×buffer3方式×同時slot数2方式×出力2方式で実行し、通常612件と実験専用 feedback 34件に加え、workload140件・adaptive scheduler 18件の計804 GPU実行を確認する。メモリを意図的に汚し、長い入力の後の短い入力やエラー後の正常系も照合する。通常の速度測定とは別に実行する。複数 slot の順序・所有期間、非同期入力 snapshot、発行後の例外時の解放もテストする。

`just bench` は3回の warmup 後20回を測り、`build/benchmark.json` に保存する。GPU frontend 時間は確保・初期化・encode/submit・最後の wait を含み、最終 JSON 化は含まない。device interval、library/pipeline setup、プロセス起動・23回の実行と最終 AST の転送を含む batch wall time も分ける。OS の Metal cache は無効化していない。CPU は TypeScript の正しさ確認用 oracle であり、最適化された CPU parser との速度比較ではない。p95 も20標本の参考値。frontend の自動 CPU/GPU 選択には、同じ契約の native CPU 実装が必要になる。

初回の tree 方式の計測 snapshot とソース SHA-256 は [`measurements/apple-m5.json`](measurements/apple-m5.json) に保存している。診断の改善を比較する `just bench-diagnostics` は、各ケースにつき同一プロセスで3方式の順序を回転し、3 warmup＋30標本＋表示用の最終1回を実行して `build/diagnostics-benchmark.json` に保存する。[試行1](measurements/apple-m5-diagnostics-trial1.json)・[試行2](measurements/apple-m5-diagnostics-trial2.json)は別の保存記録。現在は arena 再利用・選択的初期化・複数 slot を実装済み。容量上界への dispatch は残り、count を使う indirect dispatch と frontend と同じ契約の native CPU baseline は今後の比較になる。

Apple M5 での初回 tree 方式のモジュール計測（各関数に32項の式、中央値。現在の比較は上記の試行1・2を参照）：

| 関数数 | 入力 bytes | AST ノード数 | GPU frontend | GPU device interval |
|---|---:|---:|---:|---:|
| 1 | 301 | 191 | 1.21 ms | 0.86 ms |
| 32 | 9,685 | 6,112 | 1.23 ms | 0.86 ms |
| 256 | 77,713 | 48,896 | 1.78 ms | 0.62 ms |

これは8パスを通して名前解決・型検査まで済ませた時間。小さな入力でも確保・コマンド発行・同期の固定費が目立つ。device interval は OS のスケジューリング等でも変動するため、この標本で入力サイズに対する単調な増加や最適な CPU/GPU 切り替え境界は判断しない。完了 wait 単独の費用や最終 JSON 読み出しの費用も、この表では分離していない。

## 参照

- [Chez の段階文法](https://github.com/cisco/ChezScheme/blob/d533f2e156d4eddeafe24bd7cc4de87fdc88caeb/s/np-languages.ss)：パスの入出力契約。
- [Harlan の GPU lowering](https://github.com/eholk/harlan/blob/3afd95b1c3ad02a354481774585e866857a687b8/harlan/middle/compile-middle.scm)：GPU 向けの段階化。
- [Pareas](https://github.com/Snektron/pareas) と [論文](https://theses.liacs.nl/pdf/2020-2021-VoetterRobin.pdf)：GPU frontend の DFA 遷移合成と構造処理。
- [Bend](https://github.com/bendlang/bend)：所有する値と明示的 task/continuation の設計。Bend 本体や gates は変更していない。
