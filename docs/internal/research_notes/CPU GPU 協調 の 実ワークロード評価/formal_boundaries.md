# 形式化された GPU サブセットと CPU/GPU 協調の境界

調査日: 2026-11-15。Bend のコード・論文ソースはローカル HEAD `f0cf0a7c573145501981c44d9c33e326185f008e` に固定した。ベンチマークの計測日は別記する。このノートの「提案」は Metalic の設計案であり、Bend の実装済み機能ではない。

## 純粋性・アフィン制約の形式化は GPU 適性をどこまで保証するか

### Takeaway

この方針は安全な offload 境界を作るために有効である。ただし「並列に評価しても意味が変わらない」「device に載る」「速い」「有限資源で完了する」は別の契約であり、純粋・アフィン・停止性の証明をまとめても GPU の性能保証にはならない。

### Cited Findings

- 現行 Bend は昔の interaction nets/HVM の機構を使わず、アフィンな値を所有権で扱う BendRT になっている。`+` による複製は `Data` に限定され、関数・配列・ハンドルを除外する。共有されるデータには redirect と参照カウント、release/acquire が残るので、「純粋なら共有管理コストがゼロ」とは言えない。[BendRT: affine / ownership](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/BendRT/main.typ#L124), [ownership at runtime](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/BendRT/main.typ#L304)
- BendTT の証明対象には confluence、subject reduction、progress、実行コードの termination、consistency がある。ただし Lean 内の checker についての定理であり、parser と Bend→BendTT の TypeScript 変換は証明外。C runtime も未検証と明記されている。[BendTT abstract](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/BendTT/main.typ#L137), [proof boundary](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/BendTT/main.typ#L1100), [BendRT limitations](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/BendRT/main.typ#L618)
- BendRT の scheduler は work stealing / migration / rebalance を行わない。不均等な分割は lane の idle を生み、負荷を均等にする責任はプログラム側にある。「equal-parts 契約は未検証」と明記される。所有権とタスク配置の簡素化は関連するが、所有権から負荷均等性は導かれない。[scheduler](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/BendRT/main.typ#L459), [limitations](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/BendRT/main.typ#L618)
- 表現も性能を左右する。Bend の Array は実行時には flat block だが、木として match して分解・再構成すると各半分のコピーを行い、葉までの walk は `O(n log n)` words をコピーする。get/set/swap はこの分解をしない。アフィンな配列だから任意の再帰的分割が zero-copy になるわけではない。[arrays](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/BendRT/main.typ#L329)
- Futhark の PLDI 2017 論文は純粋な配列演算、uniqueness による in-place update、fusion、過剰な並列性の逐次化を組み合わせる。単に全ての入れ子並列性を flatten するのではなく、局所性を保つ変換を選ぶ。安全な並列性の抽出と、効率よく使う変換は別の仕事である。[Futhark: Purely Functional GPU-Programming with Nested Parallelism and In-Place Array Updates, PLDI 2017](https://futhark-lang.org/publications/pldi17.pdf)

### Inferences

Metalic の契約は次の層に分けるのがよい。以下は上記からの設計上の推論であり、各層を既存 Bend が証明済みという意味ではない。

| 層 | 制約から得たいもの | その制約だけでは得られないもの |
|---|---|---|
| 純粋性 / effect | 外部状態を観測せず、独立な呼び出しを並べ替えられる | 依存鎖の短さ、十分な並列幅、安い dispatch |
| affine / ownership / disjoint region | mutable alias を排除し、in-flight のアクセス権を管理できる | coalesced access、均等な仕事量、free や参照管理の安さ |
| device capability | host I/O、未対応 FFI、device 外 pointer を region から除外できる | 良い occupancy、レジスタ圧や帯域の適正化 |
| 構造的停止 / fuel | 数学的な停止、上限付き反復を表せる | 実行時間の実用上限、queue/heap/stack 上限内の完了 |
| resource bound / admission | 確保済み領域・queue に収まるか、失敗を値で返す | 高速化、scheduler の公平性 |
| work/span / layout / cost | 粒度、依存深さ、アクセス量を placement の判断材料にする | 別ハードウェアでも同じ閾値になること |

- 純粋な再帰関数を何でも GPU の一般タスクにする第一案より、特殊化後の first-order な `map / scan / segmented reduce / compact / bounded loop` を基礎にし、独立領域への書き込みと arena 上限を型・IR で記述する方が、当初の性能モデルを作りやすい。
- 汎用の木・再帰はその上の機能にする。Bend 型の continuation / task queue は表現力を増やすが、1タスクの work 推定、queue overflow、join の memory ordering、偏りを別途扱う必要がある。
- 「状態が多い」だけでは CPU 配置の十分条件にならない。GPU 内部だけで閉じる mutable worklist / temporary table は、外側から純粋な region として隠せる。一方、OS I/O・ユーザー操作・全体の取引状態などは CPU の authority として残しやすい。

### Gaps

- 今回、Bend の Lean 証明を再ビルド・再検証してはいない。証明対象と実装境界の監査であり、runtime の正当性検証ではない。
- IR の work/span 注釈から M5 の branch divergence・occupancy を静的に十分予測できる証拠は得ていない。実測 profile を持つ placement が必要になる。

## 現行 Bend は協調をどこに置いているか

### Takeaway

現行 Bend は、CPU の逐次点から純粋な部分計算を丸ごと GPU に渡し、結果を CPU continuation へ返す。GPU 内部の fork/join は runtime が処理するので CPU が一個ずつ判断する必要はない。ただし CPU と GPU が同時にユーザー計算する設計ではなく、ユーザーの提案はこの点で現行 Bend より広い。

### Cited Findings

- `f!(x)` は「他のプログラム計算が走っていない逐次点」で event loop が扱い、呼び出し全体を device に渡す。root の結果ができてから CPU の continuation を再開する。並列文脈の `!` は新しい task、逐次内部では inert などの意味に変わる。automatic な CPU/GPU cost-based placement ではない。[BendRT GPU section](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/BendRT/main.typ#L497), [actual corpus_eval](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/comp.ts#L5305)
- GPU scheduler の frontier は 128×128 の ring 群に保持される。grow は fork で幅を広げ、work は lane が queue を逐次処理する。join から次の frontier が生まれる。host が見るのは round 間の frontier count であり、branch / leaf / task 完了を全て host に返す仕組みではない。[cube / grow / work](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/BendRT/main.typ#L409)
- Metal 実装は corpus を `StorageModeShared` の no-copy buffer に包む。dispatch の大きさには indirect buffer を使い、encoder の buffer barrier を入れる。`GPU_DEEP=3` の command buffer を event で連結し、host は古い round の完了を待ちながら先の round を投入する。従って「host が処理を進める」は「CPU がユーザー関数を GPU と同時実行する」と同義ではない。[Metal buffer / dispatch / pipeline](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/comp.ts#L4925)
- Metal の device 間引き継ぎには `coherent(device)` と device fence、join の atomics が存在する。型付けされた純粋性だけで device memory ordering を代替していない。コードは `__METAL_VERSION__ >= 320` の `coherent(device)` 分岐を持つ。[device dialect](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/comp.ts#L3196), [atomics](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/comp.ts#L3477)
- IO は CPS の request と host event loop で処理され、effect 自体は evaluator 内では実行しない。device shader が OS の I/O thread を操作する仕組みではない。[effects](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/BendRT/main.typ#L509)
- GPU heap の span は事前に固定される。ring/task 数・count・Nat・block depth に上限があり、超過は fail-stop で、CPU への自動 fallback ではない。[GPU memory / failure](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/BendRT/main.typ#L487), [finite limits](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/BendRT/main.typ#L618)

### Inferences

- 協調の数は「GPU 内部の依存辺数」ではなく、「CPU が新しい意味上の判断をしないと次が進まない境界数」で数えるべき。kernel A→B→C を前もって表現できれば、その3段階を毎回 CPU の readback / 再決定にする必要はない。
- CPU 側に中央 scheduler があっても、GPU 内の branch / task completion を集約し、`done / error / frontier size / next phase` などの小さな control plane にすればよい。GPU から host I/O が必要なら request を bounded queue に出し、host の semantic boundary で扱う設計が候補になる。これは任意の CPU effect を shader 内から同期呼び出しできることを意味しない。
- 現段階の `submit / future / await` と複数 dispatch による region は、Bend が使っている仕組みを土台に検証できる。MSL 4.1 に固有な機能を必須とする理由は今回の調査範囲では出ていない。device-driven な任意再帰 dispatch や新しい visibility 契約まで広げる場合は、対応 Metal API と progress の根拠を別に確認する。
- host と device の同時実行を入れるなら、Bend の共通 corpus に任意同時書き込みを足すより、buffer/arena の所有権と immutable snapshot を分ける方が契約を明確にできる。

### Gaps

- Bend の memory ordering が全 Apple GPU / shader compiler で正しいことを証明したものではない。コードの存在と意図を確認した。
- 現行 Bend の round ごとの時間、frontier 数、host wait の寄与は今回再計測していない。round pipeline の存在から、そのコストが小さいと断定していない。

## 実ワークロードでこの設計が当たり、外れる条件は何か

### Takeaway

実用上は「粗い純粋 region を長く resident にする」「CPU の状態更新を小さい delta / summary に集約する」「依存のない別 batch を重ねる」が中心になる。負荷の偏り、逐次依存、pointer chasing、細かい CPU 判断が支配する場合、純粋なサブセットでも GPU は負ける。

### Cited Findings

- 現 checkout の最新 M4 Max record pin は **2026-09-17、stamp `d0db7b3e`**。記録自体は次の HEAD 固定 URL で追跡できる。この stamp の commit object はローカル履歴では解決できなかったため、当時のコードと現コードが完全一致すると推測しない。[record pin](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bench/runtime/_pin_/apple_m4_max.txt#L1)
- 計測 script は compiler / native build を別途済ませ、各 binary を warm run してから `/usr/bin/time -l` 経由で新しいプロセスを起動する。記録時間は spawn〜process exit の wall time で、純粋な kernel duration ではない。最初の shader compile は warm 側に入る。CPU parallel は論理 CPU 数以下の最大2冪を使い、pin には実際の `nt` を保存しない。GPU は `BEND_METAL=1` と Metal framework で build する。[measurement policy](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/gen_pins.ts#L1), [timing](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/gen_pins.ts#L60), [thread count / warm](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/gen_pins.ts#L232), [build / flags](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/gates/perf.ts#L62)

以下はすべて同 record pin の秒数。`PAR-CPU` の実測 thread count は pin にないため、16 と断定しない。旧 BendRT 論文表は別 pin（2026-08-31、`64fc4b7`）で **16 threads** を明記しており、数値を混ぜない。[latest pin](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bench/runtime/_pin_/apple_m4_max.txt#L4), [paper table conditions](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bend2/docs/BendRT/main.typ#L538)

| workload | SEQ-CPU | PAR-CPU | Metal GPU | この pin から直接言えること |
|---|---:|---:|---:|---|
| merkle | 4.222 | 0.422 | 0.071 | この大型 region では GPU が並列 CPU より約5.94倍速い |
| kmeans | 2.069 | 0.268 | 0.191 | GPU の勝ちは約1.40倍に留まる |
| queens | 5.406 | 0.455 | 0.933 | GPU は並列 CPU の約2.05倍の時間 |
| symreg | 3.014 | 0.266 | 0.529 | GPU は並列 CPU の約1.99倍の時間 |
| lexer | 2.144 | 0.198 | 1.075 | GPU は並列 CPU の約5.43倍の時間 |
| hashmap | 2.741 | 0.238 | 0.521 | GPU は並列 CPU の約2.19倍の時間 |

- `merkle` は `2^22` leaves の暗号化・hash・木構築・audit・proof の計算をまとめ、最終 checksum を返す。`kmeans` は64 independent restarts、各20 Lloyd rounds、点の判定と pairwise stats reduction を持つ。「結果を全て CPU で毎回読む」アプリの評価ではない。[merkle workload](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bench/runtime/merkle/main.bend#L2), [kmeans workload](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bench/runtime/kmeans/main.bend#L2)
- `queens` は冒頭4行の prefix index space を balanced tree に分けても、各 prefix の残りを bitmask backtracking で探索する。等しい「候補数」と等しい「実行 work」は一致しない。また停止 checker のため Nat fuel を明示する。これは停止と均等負荷が別問題である具体例になる。[queens shape / fuel](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bench/runtime/queens/main.bend#L2)
- `lexer` は `2^23` の独立行を balanced batch tree にしているが、1文字1 node の linked-list String を行内の逐次 FSM が読む。`hashmap` は独立 table を batch 化しても、boxed chain を辿る。両方とも source comment が表現の弱点を意図的に測る benchmark と明記する。pin は「純粋・独立・大量」でもこの実装で GPU が速くならなかった証拠であり、linked representation が主因という因果分解まで計測したものではない。[lexer shape](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bench/runtime/lexer/main.bend#L2), [hashmap shape](https://github.com/bendlang/bend/blob/f0cf0a7c573145501981c44d9c33e326185f008e/bench/runtime/hashmap/main.bend#L2)
- 直接関連する最新例は Futhark 公式の **2026-10-02** 記事。sparse Jacobian の前処理に逐次 graph colouring、後段に GPU 並列計算がある。従来の GPU backend は array を device 側に置くため、CPU の逐次 loop 内の要素アクセスが個別 copy＋wait に落ちていた。新しい `#[cpu_function]` は前処理を CPU にまとめ、結果を最後に bulk copy して後段へ渡す。記事は解決例を示す一方、自動最適化ではなく暫定的 attribute と説明する。記載の microseconds / 大幅な slowdown は Apple UMA の測定値に転用しない。[Keeping Futhark off the GPU](https://futhark-lang.org/blog/2026-10-02-cpu_function.html)
- Hercules（arXiv v1 **2025-03-13**）は application と schedule を分離し、IR subgraph の outlining で CPU/GPU 関数境界と host orchestration を生成する。value semantics を device memory・copy・in-place update に後から具体化する。CPU async 呼び出しは独立なら重ねられるが task 作成コストは残る。任意のデータ配置が自動で最適になる証明ではなく、schedule を書いて評価した CPU/CUDA の系である。[Hercules §§4.1–4.5](https://arxiv.org/html/2503.10855v1#S4)

### Inferences

ユーザー案を次の contract として実装すると、CPU の状態所有と GPU の粗い純粋計算を両立しやすい。これは提案である。

```text
snapshot = CPU_state.snapshot(epoch)
flight = submit(plan, ReadSnapshot(snapshot), Owned(output_arena), budget)
// CPU は別の入力・別の batch を処理できる
flight2 = flight.then_gpu(next_plan)   // host の意味判断が要らない後段
owned_output, delta, summary = await(flight2)
CPU_state.commit_if_current(epoch, validate(delta, summary))
```

- `submit` は GPU が読む snapshot と書く region のアクセス権を移す。in-flight に CPU が mutable access することは禁止する。read-only 共有を許すなら immutable snapshot として明示する。buffer・arena・pipeline の lifetime は flight に保持する。
- CPU が batch N+1 を準備しながら GPU が N を評価できるのは、N+1 の意味が N の結果に依存せず、buffer / snapshot の所有権も競合しない場合である。別 buffer にするだけでは真のデータ依存は消えない。N の commit を見て初めて N+1 を決められる workload は、その境界では順次に進む。
- `await` は GPU の完了と必要な memory visibility を成立させてからアクセス権を返す。future の drop / cancel は、device の使用中の arena を即座に解放することを意味しない。
- `delta` は「CPU 所有の全状態の再転送」ではなく、変更 index、new value、generation、必要な validation evidence などに限定する。CPU が世代の一致・範囲・意味上の前提を確認して commit する。古い snapshot の結果を捨てる policy も CPU が決める。
- `summary` は count / checksum / reduction / diagnostics count / top-k / 収束判定など、CPU の次の判断に必要な小さい出力にする。全 IR や全 token の host materialization が要る API なら、その読取・変換コストを別に計上する。共有 DRAM にあることだけでその作業は消えない。
- 不利益は二つに分ける。第一は GPU region 自体の有効 speedup が1以下になる問題で、branch divergence・pointer chasing・allocator / runtime work・入力生成等が候補になる。第二は region は速いが CPU の判断・wait・commit などの協調が critical path を支配する問題である。lexer pin は前者を疑う端緒であり、CPU scheduler の往復が律速だった証拠としては使わない。原因を確定するには GPU interval、host wait、入力生成、runtime initialization を分解する必要がある。
- CPU の論理的 authority を残したまま、変更単位を「要素ごと」から「region / chunk / epoch ごと」にまとめれば feedback の頻度を減らせる。GPU 内部の反復は固定回数・bounded predicate・device reduction で閉じ、CPU commit が必要な点だけで返す。
- CPU placement は「逐次だから常に CPU」でもない。小さな逐次処理が GPU resident の後段にしか使われず、host 往復の方が高ければ GPU 上で逐次に実行する選択がある。大きな依存鎖・重い branchy loop は Futhark の graph colouring のように粗く CPU に寄せる。
- 反対に、1要素の GPU 結果を CPU が見て次の1要素を決定する loop は、snapshot 化や future を追加しても依存鎖を消せない。kernel の高速化よりアルゴリズム変更・batch 化・CPU 完結を検討すべき境界になる。
- Metalic の compiler 用途では、連続 byte buffer の字句分類・局所変換・多数関数の独立検査・scan / compact を初期対象にしやすい。これは compiler frontend 自体の GPU 実行の提案であり、入力言語のユーザー関数を GPU 実行可能コードへ変換する機能とは区別する。linked-list AST を1 nodeずつ offload する設計は避ける。ナノパスは意味と検証の単位として保ち、実行時には同じ device region 内で fuse / batch し、各ナノパスの末尾を CPU wait に固定しない。

### Gaps

- pin は checksum まで含む batch program の比較であり、既存 compiler 全体・IDE の小さな編集・CPU authority を持つサービスの end-to-end speedup を示していない。各 workload で「CPU state → snapshot」「kernel」「await」「host validation / commit」を測り、GPU を使わない最適化 CPU baseline と比較する必要がある。
- 新 pin の stamp `d0db7b3e` の当時の完全なコード状態と実測 thread count は、この checkout のファイルだけからは復元できなかった。論文表と最新 pin の数字の違いを改善量として扱わない。
- Futhark の記事は具体的実装の一次報告だが、colouring 改善の再現可能な hardware / runtime 表は記事内にない。Metalic の性能推定に使える絶対値ではない。
- proposed delta contract の有用性は、delta の計算・検証・commit が全状態処理より十分安い workload に依存する。CPU が毎回全 IR を再走査する validator を置けば、その部分が直列律速に戻る。
