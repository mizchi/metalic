# 保存した Metal 小実験の再現条件

この測定は本会話の以前の段階で実施されたものを保存した記録であり、今回の調査中には再実行していない。original measurement from earlier in this conversation; not rerun during this research.

過去の実際の tool call で使用したコマンドは次のとおり。

```sh
xcrun clang++ -O3 -std=c++17 -fobjc-arc -framework Foundation -framework Metal bench.mm -o bench
./bench > results-final.json
```

保存された machine は Apple M5、OS は macOS 26.6.2（Build 25G83）。compiler の版、電源・省電力状態、温度や外部 workload は記録されていない。

実装は一つの `MTLCommandQueue` と `StorageModeShared` の buffer を使い、同時に in-flight になる command は一つ。PSO、queue、buffer、pages を warm にしてから測定している。shader は `out[i] = i + bias`。測定前の checksum、各 sample の結果値、command status を検査する。

scalar は warmup 100 回と本測定 1,000 回。encode 前から commit、`waitUntilCompleted`、volatile scalar read 後までを計時するほか、submit/wait、GPU command interval、GPU end timestamp から host wait 復帰までを記録する。

完了済み command に対する wait と scalar read の ready path は、測定前に GPU 完了を確認し、一標本あたり 1,000 回の呼出しを平均する。warmup 10 標本と本測定 100 標本。新しい GPU work の handoff latency を測る区間ではない。

配列の測定は 4 KiB、1 MiB、16 MiB、64 MiB の各サイズについて warmup 5 回と本測定 40 回。GPU fill の完了後、CPU 一 thread が `uint32` 全要素を `uint64` に加算する checksum を二回続けて実行し、それぞれを計時する。checksum 区間に GPU 待機時間は含めないが、load、加算、cache/memory traffic は含む。明示的な GPU-to-CPU copy の測定ではない。

コードは [bench.mm](bench.mm)、保存結果は [results-final.json](results-final.json)。一台・一 OS・一つの同期方式による warm 実験であり、Metal の最低 latency、Metal 4、非同期 callback、複数 in-flight の throughput、cold initialization、実コンパイラ workload は評価していない。
