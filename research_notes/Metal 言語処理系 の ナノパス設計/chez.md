# Chez Scheme: 実用 Nanopass の契約と実装

調査基準日: 2026-11-15。Chez の参照コミットは `d533f2e156d4eddeafe24bd7cc4de87fdc88caeb`、Framework は `c14d392487886df9275c1d4a3f0f61e1b6c4f2ef`。コードの実行・SDK 導入は行っていない。

## 1. 何が実用例で、どこから読むべきか

### Takeaway

Chez は、小さなパスと明示的な中間言語を実製品に適用した強い参照例である。reader、マクロ展開、主要 Nanopass パイプラインは区別して読む。[実用化論文](https://doi.org/10.1145/2500365.2500618)

### Cited Findings

次の6本を読書経路とする。GitHub はコミット固定、論文は DOI 固定である。

| 順 | 固定資料と読む場所 | 確認できること |
|---|---|---|
| 1 | [Keep & Dybvig, ICFP 2013](https://doi.org/10.1145/2500365.2500618), §2、§3.2–3.3、§4.2 | DSL、実製品の置換、検証とコンパイル費用。旧バックエンド5パスを約50パス・約35中間言語に分割した当時の報告。 |
| 2 | [IMPLEMENTATION.md](https://github.com/cisco/ChezScheme/blob/d533f2e156d4eddeafe24bd7cc4de87fdc88caeb/IMPLEMENTATION.md#L618), L618–659 | S-expression → syntax object → macro expansion → `Lsrc` → 前段最適化 → 主コンパイラという境界。 |
| 3 | [s/np-languages.ss](https://github.com/cisco/ChezScheme/blob/d533f2e156d4eddeafe24bd7cc4de87fdc88caeb/s/np-languages.ss#L424), L424–600、L1107–1208 | `L1` 以降の差分文法、コメントによる意味的不変条件、後半の可変 block 表現。 |
| 4 | [s/cpnanopass.ss](https://github.com/cisco/ChezScheme/blob/d533f2e156d4eddeafe24bd7cc4de87fdc88caeb/s/cpnanopass.ss#L683), L683、831、1405、1418、2011、3330、7052、10921 | パス本体。最初に `$np-compile`（L10945–10990）の呼出順を読むと迷わない。 |
| 5 | [Framework user-guide.stex](https://github.com/nanopass/nanopass-framework-scheme/blob/c14d392487886df9275c1d4a3f0f61e1b6c4f2ef/doc/user-guide.stex#L76), L138–143、884、1045–1129、2499–2515、2623以降 | `define-language` / `define-pass`、自動走査、生成コード、trace。 |
| 6 | [Flatt et al., ICFP 2019](https://doi.org/10.1145/3341642), §2–3、Fig.1–2 | Racket CS の expander → linklet → schemify → Chez という層の区別。 |

- Framework の `define-parser` は S-expression を言語定義の record 表現にするもの。文字列のトークン化や一般構文の並列解析器を生成する意味ではない。[Framework](https://github.com/nanopass/nanopass-framework-scheme/blob/c14d392487886df9275c1d4a3f0f61e1b6c4f2ef/doc/user-guide.stex#L76)
- Racket CS は、Racket expander が作る linklet を schemify で Chez の lambda に変換し、Chez に渡す。この採用実績を「Racket のすべてのコンパイラ段が Nanopass」と読み替えてはいけない。[Racket 論文 §2–3](https://doi.org/10.1145/3341642)

### Inferences

- GPU パーサの出力 `ParsedFlat` の kind、子の範囲、span、構文上の scope 所属を最初の契約にできる。その先の `BoundFlat` では参照先 BindingId を要求する。Chez の段階的制限を平坦 IR に移す提案であり、Chez 自体は GPU 前段の例ではない。[比較根拠](https://github.com/cisco/ChezScheme/blob/d533f2e156d4eddeafe24bd7cc4de87fdc88caeb/s/np-languages.ss#L424)

### Gaps

- Chez / Framework の調査範囲には GPU 字句解析・構文解析の性能証拠はない。論文の CPU コンパイル時間を Metal 前段の見積りには使えない。

## 2. 各パスは何を禁止し、何を明示するか

### Takeaway

借りるべき中心は「入力で許す形・出力で消す形」の明文化である。中間言語の文法に加え、文法だけで表せないメタデータの整合条件も別途管理している。[言語定義](https://github.com/cisco/ChezScheme/blob/d533f2e156d4eddeafe24bd7cc4de87fdc88caeb/s/np-languages.ss#L424)

### Cited Findings

- 名前解決と `np-discover-names` は同義ではない。`cpnanopass : Lsrc → L1` は `prelex` を `uvar` に変換し、既存の変数参照をその identity に結び直す。`np-discover-names : L2 → L3` は lambda / foreign の表示名を設定し、`moi` を除去する（L683–733、786–829）。後者を lexical resolution のパスとして模倣すると境界を誤る。[パス実装](https://github.com/cisco/ChezScheme/blob/d533f2e156d4eddeafe24bd7cc4de87fdc88caeb/s/cpnanopass.ss#L683)
- `np-convert-assignments : L3 → L4`（L831–873）は代入される変数を `cons` に保持し、読取りを `car`、書込みを `set-car!` に変える。lexical な `(set! x e)` は消えるが、低水準 IR のメモリ・レジスタ代入まで消えるわけではない。[パス実装](https://github.com/cisco/ChezScheme/blob/d533f2e156d4eddeafe24bd7cc4de87fdc88caeb/s/cpnanopass.ss#L683)
- `np-name-anonymous-lambda` は lambda を letrec の RHS に集める。`np-convert-closures : L5 → L6` は自由変数を収集し letrec を明示的な `closures` にし、トップレベルに未束縛変数が残れば失敗する。続く direct-call / SCC / lift を経て `np-expand-closures` または `np-expand/optimize-closures : L6 → L7` が alloc・mref・label-ref に展開する（L1405–1496、2011以降）。[パス実装](https://github.com/cisco/ChezScheme/blob/d533f2e156d4eddeafe24bd7cc4de87fdc88caeb/s/cpnanopass.ss#L683)
- 下流は primitive expansion → complex operand 除去 → context 正規化 → calling conventions → allocation pointer の露出 → basic blocks → register allocation → code generation と読む（L10921–10990）。[実行順](https://github.com/cisco/ChezScheme/blob/d533f2e156d4eddeafe24bd7cc4de87fdc88caeb/s/cpnanopass.ss#L683)
- L458–459 の「letrec 束縛 uvar の lambda 情報が RHS の情報と一致する」は、構文だけでは保証しない不変条件の例である。[言語定義](https://github.com/cisco/ChezScheme/blob/d533f2e156d4eddeafe24bd7cc4de87fdc88caeb/s/np-languages.ss#L424)

### Inferences

下は実装の転記ではなく、上記の3境界を表す独自の疑似コード。文法検査と自由変数集合の検査は別の assertion にする。[対応する実装](https://github.com/cisco/ChezScheme/blob/d533f2e156d4eddeafe24bd7cc4de87fdc88caeb/s/cpnanopass.ss#L683)

```text
boxAssigned : Bound → Boxed
  in : let x = 0; fn() { x := x + 1 }
  out: let bx = cell(0); fn() { store(bx, load(bx) + 1) }
  assert: lexical-variable assignment の node kind は存在しない

closeFunctions : NamedFunctions → Closures
  in : letrec f = fn(y) { load(bx) + y }
  out: closure f { captures = [bx], code = fn(env, y) { ... } }
  assert: 各自由変数は capture または既知の大域 binding

exposeClosures : Closures → MemoryOps
  out: p = alloc(layout); store(p.code, label_f); store(p[0], bx)
  assert: Closure / capture-list node は存在せず、layout が確定
```

### Gaps

- 文法の整合性は意味保存の証明ではない。上記の平坦 IR 向け自由変数検査、scope 検査、layout 検査は新処理系側で定義する必要がある。

## 3. 小パスの費用・検証と、Metal 向けに作り替える部分

### Takeaway

Nanopass は走査の記述量を削る。未変更ノードの再構築や複数パスの走査を自動で消す、とまでは言えない。[生成コードの説明](https://github.com/nanopass/nanopass-framework-scheme/blob/c14d392487886df9275c1d4a3f0f61e1b6c4f2ef/doc/user-guide.stex#L76)

### Cited Findings

- 差分文法の `extends`、追加 `+`、削除 `-` と `define-pass` の型指定から、未変更形の節・transformer を自動生成する。` ,[e]` は子への再帰を示し、反復フィールドでは `map` が生成される。guide L2499–2515 は、生成された未変更形もタグ検査→子の変換→新しい出力 record 構築を行うと明記する。[Framework](https://github.com/nanopass/nanopass-framework-scheme/blob/c14d392487886df9275c1d4a3f0f61e1b6c4f2ef/doc/user-guide.stex#L76)
- 2013年の実用化では整数タグによる dispatch 等を用い、ベンチ平均のコンパイル時間は旧版比1.64–1.75倍だった。ただし register allocator や最適化も変更しており、純粋なパス分割費用の比較ではない。既存の unit / functional / regression suite と自己コンパイルの整合性を検証に使った。[ICFP 2013 §2.3、§3.3、§4.2](https://doi.org/10.1145/2500365.2500618)
- Framework は `echo` で展開コード、`trace-define-pass` で入力・出力 IR の S-expression を観察できる。Chez 自身も `pass` / `$xpass` に unparser とパス時間測定を集約する（L87–139）。ただし Chez 内部の `tracer` には現在未使用・thread-safe とは限らないという注記がある。[Framework](https://github.com/nanopass/nanopass-framework-scheme/blob/c14d392487886df9275c1d4a3f0f61e1b6c4f2ef/doc/user-guide.stex#L76)、[Chez instrumentation](https://github.com/cisco/ChezScheme/blob/d533f2e156d4eddeafe24bd7cc4de87fdc88caeb/s/cpnanopass.ss#L683)
- 全段が不変な木という理解も不正確で、`L15a` は mutable fields を持つ `block` を terminal として扱う。[block 定義 L1107–1125、L15a](https://github.com/cisco/ChezScheme/blob/d533f2e156d4eddeafe24bd7cc4de87fdc88caeb/s/np-languages.ss#L424)

### Inferences

- 新処理系では、段階別 schema から flat IR の kind 検査、field の範囲検査、dump、CPU 参照変換を生成するのが最も再利用価値の高い部分。GPU parser が生成する span / scope 列を後段でも保ち、最初に契約を破った段を特定する。[着想源](https://github.com/nanopass/nanopass-framework-scheme/blob/c14d392487886df9275c1d4a3f0f61e1b6c4f2ef/doc/user-guide.stex#L76)
- record identity、リスト `map`、再帰スタック、可変フィールドは、NodeId・列・worklist と段階別の更新権限に置換する。closure analysis の mask / 自由変数蓄積は side table に分離する案が考えられる。[元の状態: np-convert-closures](https://github.com/cisco/ChezScheme/blob/d533f2e156d4eddeafe24bd7cc4de87fdc88caeb/s/cpnanopass.ss#L683)

### Gaps

- 確認した Framework と Chez のコードから、一般的な自動 pass fusion や未変更サブツリー共有を保証する仕組みは確認できなかった。GPU の kernel 統合・転送削減は独立に測定すべき課題である。
