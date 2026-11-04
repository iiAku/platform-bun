# Validation

Baseline: `@nestjs/platform-node@12.3.3`, Nest source commit
`59f33793c616eaf9669e8b81a35aa5f31accc5b4`. Runtimes: Bun 1.4.4 (`38afee6c8`),
the latest Bun release, and Node v26.13.0, the latest LTS, for the Node side of
the differential tests and the benchmarks, on Linux.

The transport rewrite (`Bun.serve()` only; see [COMPATIBILITY.md](./COMPATIBILITY.md))
passed the checks below on 2026-10-31; the whole suite was last run on
2026-11-04:

| Check | Result |
| --- | --- |
| Upstream-derived unit tests, real Nest integrations and the transport tests (`bun run test`, Node 26 on `PATH`) | 1,594 passed, 0 failed, 0 skipped, in 69 files (57.9 s and a 273 MB peak under a 6 GB memory cap, with the benchmark runners' tests, which start real runs, and the keep-alive tests, which wait on Bun's idle timer) |
| Transport tests (`bun test test/transport`) | 71 passed: the 50 contract tests, the port's 6 and 15 keep-alive tests |
| Mutation check of the transport's new decisions | 48 mutants: 44 killed, 4 equivalent (below) |
| Mutation check of the keep-alive timeout | 12 mutants, all killed: 10 by a failing test, 2 (inverting the check for a reply produced during dispatch) by hanging every reply past the checker's 120 s limit, which applied by hand fail the contract tests |
| Mutation check of the Nest benchmark runner (`test/benchmark`) | Its port and signal handling: 6 of 6 mutants killed, and each of its 8 decisions, removed by hand, fails a test. Its CPU figures: 6 of 6 mutants killed, and each decision changed by hand fails a test (the softirq column, the CPUs counted, the time base, a missing reading, each figure's window), except one that changes nothing: also matching the all-CPU line of `/proc/stat`, which the `cpu0` line after it replaces |
| Mutation check of the benchmarks' second load generators (oha in the controllers benchmark's runner, wrk in Nest's) | 52 of 52 mutants killed, then 11 of 11 and 9 of 9 for the two rounds of review fixes. The fixes' decisions the checker cannot mutate, changed by hand, fail a test, except one that changes nothing: requiring oha's counts to be above 0 rather than at least 0, since oha lists only the statuses and errors it met |
| Mutation check of `close()`'s wait for further requests on busy connections | 7 mutants, all killed: 3 by a failing test, 4 (inverting its two in-flight checks) by hanging `close()`, which applied by hand fail 15 and 16 tests. Its other decisions, removed or changed by hand (the wait, its restart after each reply, the two times it counts from, its length set to 100 or 1000 ms, the first check, the pending timer cleared when it stops, `closeAllConnections()` ending it, and the removal of its listeners), each fail a test |
| Mutation check of the Content-Length of a reply without a Content-Type | 1 mutant (flipping the check for a string body), which crashed the checker and, applied by hand, fails 43 transport tests. The decisions the checker cannot mutate, changed by hand (no queuing strategy for the body, a 16 KiB high-water mark instead of an unbounded one, a typed reply losing its body), each fail a test |
| Mutation check of the benchmark reports, chart and run records (`test/benchmark`) | 63 mutants: 45 killed, then tests written for the 18 survivors (the chart's markup, workload labels and emphasis, single-round wording, leads only for a complete run that measured platform-bun, a route without valid trials, the runtimes line, warnings); rerun on the report and chart modules, 46 of 47 killed, and the last (the legend's swatches), applied by hand, fails a test. After the review's fixes, the chart's 25 mutants were all killed |
| Mutation check of the Nest 12.3.3 port (`use()` with a list of mount paths, `req.res`, a wrapped `res.send()` or `res.json()`, index views) and of the report naming the Nest version a run measured | 28 mutants: 26 killed. The survivor, the bound of the loop that finds the mount paths' common prefix, only shortened the prefix the router's skip shortcut compares, which changes no reply; a direct test of that prefix now kills it. The last mutant (`\|\|` for `&&` in the same loop) crashed the checker, never ending on two equal prefixes, and applied by hand fails that test |
| Types, lint and formatting | `bun run check`, `bun run lint` and `bun run fmt --check` passed |
| Build | `bun run build` (`tsc`, TypeScript 7.0.2) passed |
| Clean packaged consumer | The packed tarball, installed in a clean project with Nest 12.3.3, passes strict `tsc` (TypeScript 7.0.2), setting the keep-alive timeouts through the public types, and serves a Nest app on Bun (GET and JSON POST) |

The consumer passes a full lib check (`skipLibCheck: false`) with the latest
`@types/node` (26.6.6, what `bun-types` resolves when a project pins none).
With `@types/node` 24 that check stops inside `bun-types@1.4.4`'s own
declarations (`overrides.d.ts`, `globals.d.ts`), which use Node types newer
than 24 and which this package's declarations import for the `Bun.serve()`
types; no error is reported in this package's declarations, and
`skipLibCheck: true`, Bun's recommended setting, passes.

The mutation check (`earned-code`) mutated each decision the stream rework
added to the transport, against the transport before it, and ran the tests
on every mutant. Of 48 mutants, the transport tests killed 31 (4 of them by
failing, then hanging), the full suite 5, and tests added for the survivors
8: the shared `Headers` cache and its bound, the state of a request nothing
read once its response is done, a custom reason phrase, a paused
middleware sharing the body with the body parser, and `close()` waiting for
a `server.fetch()` request. The other 4 change no observable
behavior: building a request's stream before declining the one-call native
read (`[READ_NATIVE_BODY]()` in `bun-http-server.ts`), keeping a
Content-Length Bun ignores for a sized body (`headersInit()`), emitting the
drain wake-up more often than needed (`requestDone()`), and a check in
`close()`, since replaced, that only a `server.fetch()` request started within
the same turn could reach.

The runners' tests replace oha and wrk with fake executables, which record
how they were run and print canned figures, so the wrk script
(`benchmark/nest/wrk-pipeline.lua`) runs only under a real wrk. It was
checked on the wire with wrk 4.2.0: a server counting the requests
outstanding on each connection found exactly 10, the pipelining depth, at
every one of 7,310 batches.

No tests are skipped or marked TODO. Negative-path tests intentionally log
exceptions for missing files, rejected uploads, invalid hosts, aborted streams
and a port already in use; those logged exceptions are covered passing cases.
Bun also prints the error of a response body stream that the adapter errors on
purpose (a destroyed response) to stderr. The wire-level differences from
`node:http` have executable expectations in the differential and contract
suites; none is skipped.

## Reviews

- A design review before the rewrite (Codex, adversarial, from the planned
  design and the measured Bun behaviors) confirmed two requirements: `'finish'`
  must not fire before a streamed body is handed off, and the Writable/pipe
  contract (backpressure, `'drain'`, write-after-end) must hold for `pipe()`
  consumers. Both are implemented and covered by the transport contract tests.
- A blind diff review of the rewrite (Codex, given the diff without the
  author's framing) confirmed two defects, both fixed before this validation:
  `'finish'`/`'close'` fired as soon as a chunked body was handed to Bun, even
  with chunks still queued for a slow client (now the response finishes once
  Bun's writer has taken every chunk, as Node's does once the kernel has), and
  the body parser's native read reported a `received` count of 0 on a client
  abort (now reported as unknown).
- An adversarial multi-agent review of the rewrite (37 agents over five
  dimensions: lifecycle leaks, ordering hazards, the Node contract, the body
  parser, the adapter and its documentation; each finding reproduced by a
  probe and challenged by a refuter) confirmed 16 findings, 12 of them
  distinct, and left 3 unverified at its verification cap. All 15 were
  addressed: 13 fixed with a test each (among them a client that left before
  anything listened going unnoticed, which leaked the response and kept
  `close()` from completing; `close()` doing nothing after a second
  `listen()`; new connections accepted while `close()` drained; `write()`
  callbacks firing before Bun took the chunk; and the HTTPS facade missing the
  server timeouts), and two documented in COMPATIBILITY.md as limits of
  `Bun.serve()`: `Content-Length: 0` on a HEAD reply without one, and duplicate
  Content-Type lines joined.
- A design review of the benchmark runner (Codex) found that the `@node`
  targets measured whichever Node was on `PATH` and that a single fixed-order
  pass biased later targets; the runner now uses the Node it runs on (or
  `--node`), records the versions measured, and runs rotated rounds with
  medians.
- A blind diff review of the stream rework (Codex) raised one finding, that a
  `write()` callback can fire before Bun pulls a chunk when the write reaches
  the declared Content-Length; it was rejected as the documented behavior: a
  body closed by its declared length is handed to Bun whole, and no later
  acknowledgment exists for it.
- A blind diff review of the lazy request stream and the response path
  (Codex, against the transport before that work, in two rounds: the diff,
  then its lifecycle paths with the contract tests read) confirmed no
  finding. The coverage gap it first suggested, for the microtask drain, is
  covered by three contract tests whose guard mutants were all killed. Its
  speculative case, a request stream first used after the response while
  the body is still arriving, cannot occur: once the response is out, Bun
  closes the connection of a body nobody read (checked on 1.4.4), which
  COMPATIBILITY.md lists, and the contract tests pin the request's state
  after it.
- A blind diff review of the Nest benchmark runner's fix (Codex) confirmed
  one finding: the free-port check and the server's own bind were separate
  steps, so a process taking the port in between would have been measured.
  The runner now also fails a run whose server exited before its
  measurement ended, which fixed a hang (Node then exited 0 without a
  report) when a server died by a signal; both are covered by tests that
  replace the runner's server during the warm-up and during the measured
  run.
- A blind diff review of the runner's CPU figures (Codex, two rounds)
  confirmed two findings, both fixed: a pinned run on a host without
  `/proc/stat` would have stopped with an error instead of reporting no
  softirq figure, and the measured window opened after the first CPU
  snapshot (about 0.02% of a run). The second round reviewed a defect found
  in the run's raw data: autocannon stops on its one-second sampler, so a
  `--duration 10` run can last 11 s, and the runner divided every CPU figure
  by 10. All three figures (server, softirq, generator) are now per second
  of the measured window, covered by a half-second run, which autocannon
  always stretches to a second.
- A design review of the keep-alive timeout (Codex, before its tests) found
  that the planned socket tests could all pass with one hard-coded idle
  timeout: the tests now check a setting other than the shortest end to end,
  and settings changed after `listen()`. Its finding, that Bun's idle timer
  runs while Bun writes a one-body reply to a client that reads nothing, is a
  limit of `Bun.serve()`, which reports no end of that write and ignores
  `server.timeout()` once it is done; it was measured (a client reading every
  3 s gets a 64 MiB reply whole, one that stalls for 12 s is cut once the
  socket buffers are full) and is listed in COMPATIBILITY.md.
- A blind diff review of the keep-alive timeout (Codex) confirmed no finding;
  the path it found untested, a reply with its own Content-Type, which Bun
  gets as a body rather than a stream, has a test.
- A design review of the second load generators (Codex, from the plan)
  confirmed two findings, both settled before the code was written. A wrk
  script given the pipelining depth could still send one request at a time
  while tests built on a fake wrk passed: the runner builds the batch itself
  and hands it to the script, the tests check its bytes, and the wire check
  above confirms what wrk sends. And wrk counts no redirect as an error, so
  its status column could not claim to count every non-2xx answer: it reads
  4xx–5xx, and the report says why.
- A blind diff review of the second load generators (Codex) confirmed three
  findings. Two were fixed with tests: figures that wrk's script or oha left
  incomplete (no request count, no duration, no latency for answered
  requests, a missing distribution) came out as NaN or 0 instead of stopping
  the run, and now stop it. The third, that the Nest runner should stop on
  wrk's socket errors and error answers, was rejected: that runner reports
  such counts rather than stopping, as Nest's benchmark does, with autocannon
  as with wrk. Its speculative case, oha following redirects, does not hold
  for oha 1.16.0, whose default is not to follow them, but older releases
  followed up to ten, so the runner now passes `--redirect 0`; and the tests
  of a failing generator now fail the measured run, after a clean warm-up.
  A blind review of those fixes (Codex) confirmed three more findings, all
  fixed with tests: figures of the wrong type or sign still passed (a
  duration of `true`, a null or negative count, counts cancelling out, a
  negative rate or latency). Both runners now require whole, non-negative
  counts, a positive duration and non-negative measures; all 54 oha and 42
  wrk outputs of the 2026-11-04 runs meet them.
- A design review of `close()`'s wait for further requests (Codex). On
  GitHub's runner, Nest's upstream test of a request a keep-alive client
  queues behind a reply during shutdown got a reset instead of a 503: after
  the reply, `close()` gave the request one timer turn, about 1 ms, and the
  client takes 0.2 ms (median) to 1.3 ms (most of 100 runs) to send it.
  Replayed 20 times, `platform-node` on Node answered all of them and the
  adapter 19; with the change, the adapter answered 50 of 50. The review
  agreed with the diagnosis and confirmed one finding: a fixed wait can always be outrun by a slower client, which only
  Node's rule, the connection's whole keep-alive time, rules out. On Bun
  that would keep the port bound, answering new connections with a 503
  instead of refusing them, for that long, so the adapter waits 250 ms (see
  COMPATIBILITY.md), which the maintainer chose over the longer wait. Its
  counterexamples are tests: a wait started at `close()` rather than after
  the reply, a wait not started over after each reply, and
  `closeAllConnections()` ending it.
- A blind diff review of that wait (Codex) confirmed no finding. Of its
  three coverage gaps, one was a defect: with a `server.fetch()` request in
  flight, `closeAllConnections()` made `close()` stop twice and emit
  `'close'` twice; it is fixed, with a test. The others are tests too: the
  length of the wait, and a `server.fetch()` request made during it.
- A blind diff review of the Content-Length of a reply without a
  Content-Type (Codex) confirmed no finding. Such a reply went out chunked
  from 256 bytes, without the length Node sends: Bun adds a Content-Type to
  a string or bytes body, so the adapter sends it as a closed stream, and
  Bun frames a closed stream by its length only when the whole queue is
  under the stream's high-water mark, which is now unbounded. The review's
  counterexamples are tests: a large finite high-water mark (a 16 MiB body
  rules it out), bodies of 1 and 256 bytes, a latin1 string, and the exact
  16 KiB boundary of a streamed body with a declared length.
- A blind diff review of the benchmark reports, chart and run records
  (Codex) confirmed two findings, both fixed with tests: the chart drew
  leads from an incomplete run, whose report gives none, and it accepted a
  rate of zero or `NaN`, which would have printed `+Infinity%`. It now
  refuses both, and a Nest target that met errors, timeouts or error
  answers, which Nest's runner reports instead of stopping. The review
  found no figure in the README or the reports that disagrees with the
  runs, and noted that nothing would catch one drifting: a test now checks
  that each committed report and the chart are what their runs render, and
  that the README's chart description and lead table state the runs'
  figures.
- A blind diff review of the Nest 12.3.3 port and the dependency updates
  (Codex) confirmed no finding. It named three wrong implementations the
  tests would have let through, each now a test that fails when that
  implementation is applied by hand: an adapter that also sends the body
  after a wrapped `res.json()`, or the empty reply after a wrapped
  `res.send()`, which then sends it later; `req.res` set after the first
  middleware has run; and a nested list of mount paths whose prefix, for
  the router's skip, is its first entry's.
- A review of the regression check of the Nest 12.3.3 port and the
  dependency updates (Codex). Comparing builds in process had found no
  regression; the review held that this did not rule one out, since calling
  the fetch handler in process skips the sockets, where an object kept alive
  longer or a dependency could cost more under 100 connections, and asked
  for the old and new releases to be compared over sockets, paired in
  randomized blocks with a control. That comparison found no regression
  (Benchmark, below).

## Benchmark

All four runs ran on 2026-11-04, one after the other: the controllers
benchmark at 14:45 UTC, Nest's at 14:52, and their cross-checks at 15:07
and 15:14 (below), under the same conditions: an AMD Ryzen 9 9900X (12
cores, SMT disabled in the firmware, 60 GiB, Linux 7.1.12, the `performance`
power profile: `performance` governor and hint), Node v26.13.0 and Bun
1.4.4, Nest 12.3.3, and autocannon 8.0.0 on Node 26 as the load generator;
the servers pinned to CPUs 0–3 and the generator to CPUs 4–11, the same for
every target; three rounds with the target order rotating between them,
medians reported with their min–max. A desktop session and two coding-agent
sessions stayed open, none of them pinned, with no virtual machine running;
the load average was 0.5 when the first run started and 2.3 when the second
did, the first having just ended (a run's own servers and generators keep it
near 2). Each report records these conditions, the versions measured and the
command that reproduces it, and the README's chart is drawn from the two
autocannon runs' raw data (`node benchmark/chart.mjs`). The adapter measured
is the one published here.

**The controllers benchmark** (the workload of Nest PR #18063: real Nest
controllers, 100 connections, no pipelining, four autocannon workers; 54 of 54
trials valid, every response body checked), median requests/s:

| Route | platform-bun on Bun | platform-node on Node | platform-node on Bun | platform-fastify on Bun | platform-express on Bun |
| --- | ---: | ---: | ---: | ---: | ---: |
| GET `/` | 168,973 | 138,950 | 146,138 | 129,677 | 114,925 |
| GET `/users/42` | 164,032 | 131,014 | 136,205 | 124,378 | 108,986 |
| POST `/echo` | 126,202 | 102,458 | 113,978 | 105,043 | 82,234 |

platform-bun on Bun is ahead of platform-node on Node by 21.6%, 25.2% and
23.2%, and of platform-node on Bun by 15.6%, 20.4% and 10.7%, with no overlap
between their min–max ranges. The lead over platform-node on the same runtime
is the adapter's own: platform-node itself is faster on Bun than on Node here
(+5.2%, +4.0%, +11.2%). `Bun.serve()` alone, with no Nest, served 202,790,
196,134 and 166,643 requests/s. Run:
[report](./benchmark/results/controllers-autocannon/report.md), [raw
data](./benchmark/results/controllers-autocannon/raw.json).

**Nest's own benchmark** (`tools/benchmarks`: GET `/` returning "Hello
world!", 100 connections, pipelining 10, a single autocannon in the runner; 14
targets, 42 of 42 trials without an error), median requests/s, with the server
process's CPU and the softirq time of the server's CPUs, in cores:

| Target | Requests/s (min–max) | Server CPU | Softirq |
| --- | ---: | ---: | ---: |
| platform-bun on Bun | 194,193 (188,119–196,579) | 0.60 | 0.44 |
| platform-node on Node | 172,841 (172,748–175,098) | 0.64 | 0.36 |
| platform-node on Bun | 153,606 (152,919–161,367) | 0.62 | 0.41 |
| platform-fastify on Node | 157,504 (157,015–159,366) | 0.67 | 0.34 |
| platform-fastify on Bun | 127,244 (125,492–130,697) | 0.61 | 0.41 |
| platform-express on Node | 102,275 (100,314–102,467) | 0.76 | 0.24 |
| platform-express on Bun | 114,505 (113,743–117,844) | 0.63 | 0.40 |
| `Bun.serve()` on Bun (no Nest) | 281,030 (274,397–299,532) | 0.56 | 0.44 |
| `node:http` on Node (no Nest) | 200,675 (195,706–203,875) | 0.62 | 0.38 |
| `node:http` on Bun (no Nest) | 185,792 (184,035–186,769) | 0.60 | 0.43 |

platform-bun is 12.4% ahead of platform-node on Node, with no overlap between
their min–max ranges, 26.4% ahead of platform-node on Bun, and ahead of the
Fastify and Express adapters on either runtime. Run:
[report](./benchmark/results/nest-autocannon/report.md), [raw
data](./benchmark/results/nest-autocannon/raw.json).

Every server here is saturated. Each handles its requests on one thread, and
on loopback the kernel delivers each response to autocannon, and wakes it, in
softirq on that thread's CPU, time that this kernel
(`CONFIG_IRQ_TIME_ACCOUNTING=y`) books to no process. The thread and that
softirq time share one core, so a server's limit is one core even though it
may run on any of CPUs 0–3, and every target reaches it: the server's CPU and
that softirq time add up to 1.00–1.01 cores on Node and 1.00–1.04 on Bun,
whose garbage collector also runs on helper threads beside the main one. The
load generator is not the limit: it used 0.48–0.85 cores, and through it the
bare `Bun.serve()` handler served 45% more requests than platform-bun.

platform-bun's lead over platform-node on Node is smaller here than in the
controllers benchmark, which differs in more than pipelining (its routes, four
generator workers, shorter runs), so how much of that pipelining alone
accounts for was not measured. What is measured here: every server answers
pipelined requests with one TCP segment per response, bare `Bun.serve()` and
`node:http` alike (ten requests sent in one segment get ten data segments
back, checked three times for each of the fourteen targets on the build
measured), so each response pays its own delivery: 2.11 µs of kernel time per
request for platform-node on Node and 2.27 µs for platform-bun, 36% and 43%
of their time, a share in which platform-bun saves nothing. platform-bun
spends less process time per request, 3.07 µs against 3.71 µs, part of it on
its garbage collector's helper threads beside the main thread, and it serves
12.4% more requests.

platform-node is slower on Bun than on Node here (−11.1%), and so is bare
`node:http` (−7.4%). On Bun, `node:http` is Bun's compatibility layer: Node's
`Server`, `IncomingMessage` and `ServerResponse` written in JavaScript over a
native handle (their source prints as JavaScript on Bun 1.4.4), where Node
runs its own implementation. Per request it costs platform-node 4.01 µs of
process time on Bun against 3.71 µs on Node, and 2.67 µs of kernel time
against 2.11 µs. In the controllers benchmark, platform-node is faster on Bun
instead (above). Bun's speed is in its native API: the bare `Bun.serve()`
handler runs 40% ahead of `node:http` on Node, and platform-bun is built
directly on it.

**Cross-checks with oha and wrk.** Right after the autocannon runs, the two
runners measured the same targets again, each with a second load generator,
under the conditions above (load average 1.8 and 2.1 at the starts, the
second run right after the first). The controllers benchmark ran with oha
1.16.0, which keeps one request in flight per connection, as autocannon does
there (54 of 54 trials valid; response bodies checked before each warm-up,
not under load). Nest's ran with wrk 4.2.0 and four threads, which send each
connection's ten pipelined requests as one batch, and the next batch once all
ten are answered, where autocannon sends a request as each response arrives
(42 of 42 trials without an error; wrk's latency is not reported). Median
requests/s:

| Benchmark | Generator | platform-bun on Bun | platform-node on Node | platform-node on Bun |
| --- | --- | ---: | ---: | ---: |
| GET `/` | autocannon | 168,973 | 138,950 | 146,138 |
| GET `/` | oha | 169,366 | 132,381 | 145,820 |
| GET `/users/42` | autocannon | 164,032 | 131,014 | 136,205 |
| GET `/users/42` | oha | 160,699 | 127,819 | 137,410 |
| POST `/echo` | autocannon | 126,202 | 102,458 | 113,978 |
| POST `/echo` | oha | 129,313 | 100,558 | 115,449 |
| Nest's, pipelining 10 | autocannon | 194,193 | 172,841 | 153,606 |
| Nest's, pipelining 10 | wrk | 207,084 | 185,615 | 172,335 |

oha ranks the six targets of the controllers benchmark (with Fastify,
Express and bare `Bun.serve()`) in autocannon's order on every route. wrk
ranks the seven Nest adapters of Nest's matrix in autocannon's order but for
two neighbours: platform-node on Bun and platform-fastify on Node, 2.5% apart
under autocannon with overlapping min–max ranges, swap places, platform-node
on Bun leading by 5.0% under wrk. platform-bun's min–max range stays clear of
platform-node's under each generator. platform-bun leads platform-node on
Node by 25.7–28.6% under oha (21.6–25.2% under autocannon) and by 11.6% under
wrk (12.4%), and platform-node on Bun by 12.0–16.9% under oha (10.7–20.4%)
and by 20.2% under wrk (26.4%). The margins move by several points with the
generator, so each figure belongs to its tool; platform-bun's first place
does not move. Under wrk every server is still saturated (its CPU and the
softirq of its CPUs at 1.00–1.04 cores), and wrk used 0.27–0.55 cores. Its
bare `Bun.serve()` ceiling is 7.7% lower than under autocannon (259,407
against 281,030 requests/s) while the seven Nest adapters are 3–15% higher:
how the requests arrive changes what each costs, which these runs do not
break down. Runs: oha
[report](./benchmark/results/controllers-oha/report.md) and [raw
data](./benchmark/results/controllers-oha/raw.json); wrk
[report](./benchmark/results/nest-wrk/report.md) and [raw
data](./benchmark/results/nest-wrk/raw.json).

**Against the previous release.** Before these runs, from 14:02 to 14:20
UTC, this release was compared with the previous one over real sockets, to
rule out a regression from the Nest 12.3.3 port or the dependency updates.
Six blocks, each in its own random order, ran four servers: the previous
release (built from its own tree, with Nest 12.3.2 and the dependencies it
pinned), this release, the previous release's code on this release's
dependencies, and bare `Bun.serve()` as a control. Each server started fresh,
through the runner of its own tree, with the settings of the runs above but a
single round: Nest's benchmark under wrk, then the controllers benchmark
under autocannon, on a busier machine than the runs above (load average
0.4–9.0, then 3.4–4.9). Paired by block, this release served +1.4% against
the previous one on Nest's benchmark (95% interval −1.7% to +4.5%), and
−0.9% (−2.7% to +0.8%), +1.1% (−2.7% to +5.1%) and +5.1% (−4.2% to +15.4%)
on the controllers benchmark's GET `/`, GET `/users/42` and POST `/echo`; the
code changes alone, on the same dependencies, moved it by −1.3% to +1.5%. No
run had an error, and no build's memory grew (peak RSS 88–104 MB for every
build). The `Bun.serve()` control moved by up to 11% from one block to the
next: a run's absolute figures belong to its session, and what a run
establishes is the comparison between the targets it measured.

**In process**, a development measurement between builds of the work in
progress rather than one of the published benchmarks (the fetch handler
called with native `Request`s in batches of 10, without sockets; medians of
five interleaved runs on one pinned core), a Nest request costs 934 ns, against 1,516 ns before the
response-path iteration, and the transport alone 382 ns against 735 ns.
Of those 582 ns, running a request's microtasks before returning to Bun
accounts for about 271 (1,254 → 983 ns, between two intermediate builds
that differ only in it).

Bun 1.4.4 was downloaded from its official tagged release and verified against
the release asset SHA-256; runtime provenance is in
[validation/bun-1.4.4.json](./validation/bun-1.4.4.json).
