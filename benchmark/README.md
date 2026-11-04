# Benchmarks

Two benchmarks compare platform-bun on Bun with the published `@nestjs/platform-node` on Node and on Bun, and with Nest's Express and Fastify adapters:

- **The controllers benchmark** (`benchmark/run.ts`): real Nest controllers on three routes, the workload of [Nest PR #18063](https://github.com/nestjs/nest/pull/18063), without pipelining.
- **Nest's benchmark** (`benchmark/nest/`): Nest's own `tools/benchmarks`, GET `/` with pipelining 10, across runtimes.

Every run writes a readable `report.md` and the `raw.json` it is rendered from. The committed runs, all on the same machine under the same conditions:

| Benchmark | Load generator | Started (UTC) | Run |
| --- | --- | --- | --- |
| Controllers | autocannon 8.0.0 | 2026-11-04 14:45 | [controllers-autocannon](results/controllers-autocannon/report.md) |
| Controllers | oha 1.16.0 | 2026-11-04 15:07 | [controllers-oha](results/controllers-oha/report.md) |
| Nest's | autocannon 8.0.0 | 2026-11-04 14:52 | [nest-autocannon](results/nest-autocannon/report.md) |
| Nest's | wrk 4.2.0 | 2026-11-04 15:14 | [nest-wrk](results/nest-wrk/report.md) |

The four runs measured the adapter published here, one after the other. The README's [Performance](../README.md#performance) section summarizes these runs, and [VALIDATION.md](../VALIDATION.md#benchmark) goes through them: the servers' CPU and kernel time, the cross-checks, and what each figure rests on.

## The controllers benchmark

Build once, then run all targets sequentially (the runner refuses a missing or stale Bun build):

```sh
bun install --frozen-lockfile
bun run build
bun benchmark/run.ts
```

The default run compares this adapter (`bun`: `new BunAdapter()` over `Bun.serve()`), the published `@nestjs/platform-node` on Bun (`node-bun`) and on Node (`node-node`), and Express and Fastify on Bun (`express-bun`, `fastify-bun`). Reports name each target by its adapter and runtime: platform-bun on Bun, platform-node on Node, platform-node on Bun, platform-express on Bun and platform-fastify on Bun, and `raw-bun` as `Bun.serve()` on Bun (no Nest). Every target serves identical real Nest controllers: plaintext GET, JSON with a route parameter, and JSON POST. For returned strings, Express keeps its default `text/html` media type; the other adapters return `text/plain`. All response bodies and statuses are identical. The workload comes from [Nest PR #18063](https://github.com/nestjs/nest/pull/18063).

The driver uses a separate Node process with four autocannon workers, 100 total connections, HTTP/1.1 keep-alive and no pipelining. Each route gets two seconds of warm-up and five seconds of measurement for each of three rounds. Servers run one at a time, and adapter order rotates between rounds. Avoid running tests, builds, or other CPU-intensive work during measurement.

Options:

```sh
bun benchmark/run.ts --duration 8 --warmup 3 --rounds 3 --connections 100 --workers 4
bun benchmark/run.ts --targets bun,node-bun,node-node
bun benchmark/run.ts --targets raw-bun,bun,node-bun
bun benchmark/run.ts --node /path/to/node --bun /path/to/bun --output benchmark/results/my-run
```

`raw-bun` is a transport ceiling without Nest; it does not represent an equivalent application. Runtime executables also accept `BENCH_NODE` and `BENCH_BUN` environment variables. By default the Bun executable is the one running `run.ts`; the Node executable is `node` on `PATH`.

Every run writes `raw.json` and a readable `report.md` under `benchmark/results/<timestamp>/`. The record names the executables it ran relative to the repository when they are inside it and from `~` in the home directory, and keeps no host name, so a committed run names nobody's machine. Raw results retain request/latency histograms, exact-body mismatch counts, transport errors, timeouts, response status totals, trial order, runtime versions, preflight response headers, server CPU usage on Linux, server stderr, and machine metadata. Failed trials are retained in the raw data and excluded from medians; incomplete runs do not publish relative-speed ratios. All requests are validated before timing; mismatches or errors fail the run.

For a quick wiring check (not enough evidence for a performance claim):

```sh
bun benchmark/run.ts --duration 1 --warmup 1 --rounds 1 --targets bun,node-bun
```

Run one server manually, if desired:

```sh
BENCH_PORT=3000 bun benchmark/server.mjs bun
BENCH_PORT=3000 bun benchmark/server.mjs node
BENCH_PORT=3000 node benchmark/server.mjs node
```

## Nest's benchmark, across runtimes

`benchmark/nest/` is Nest's `tools/benchmarks` (at the pinned commit) as a runtime matrix: the same `GET /` returning `Hello world!` with `bodyParser: false` and `logger: false`, 100 connections, pipelining 10, a full-length warm-up then a measured run with autocannon in the runner process, one server at a time. Every target names the runtime that runs it, so the published Node adapter and this adapter are measured on Node and on Bun with one load generator (Node). A target is `framework@runtime`; reports name it by its adapter, `nest-bun@bun` as platform-bun on Bun and `nest-node@node` as platform-node on Node, or by its server without Nest, `bun@bun` as `Bun.serve()` on Bun (no Nest) and `node@node` as `node:http` on Node (no Nest). The controller is decorated by hand so that the same files run under both runtimes without a build.

```sh
bun run build
node benchmark/nest/main.mjs                       # node@node, nest-node@node, node@bun, bun@bun, nest-node@bun, nest-bun@bun
node benchmark/nest/main.mjs --all                 # adds Express and Fastify, raw and as Nest adapters, on both runtimes
node benchmark/nest/main.mjs --targets nest-node@bun,nest-bun@bun --node /path/to/node --bun /path/to/bun
node benchmark/nest/main.mjs --rounds 3 --duration 10 --pipelining 10 --connections 100 --port 3000 --output benchmark/results/my-run
```

The `@node` targets run on the Node given by `--node` (or `BENCH_NODE`), by default the Node running the runner itself, so `~/.nvm/versions/node/v26.13.0/bin/node benchmark/nest/main.mjs` measures Node 26 and the report names the version measured. The `@bun` targets run on `--bun` (or `BENCH_BUN`), by default `bun` on `PATH`. Three rounds are run by default, the target order rotating between rounds, and medians are reported with the min–max of each target; `--rounds 1` is Nest's single pass. `bun@bun` is a bare `Bun.serve()` handler, the ceiling of the runtime: the report also records the CPU cores the load generator used, so a run where the generator approaches one core, or where the ceiling is no faster than the adapters, is known to be limited by the generator. It records the softirq time of the server's CPUs as well: on loopback the kernel delivers the server's responses, and wakes the load generator, in softirq on the server's CPU, which Linux books to no process when it accounts IRQ time on its own (`CONFIG_IRQ_TIME_ACCOUNTING`), so a server whose CPU and softirq time add up to one core is saturated: it handles its requests on one thread, which shares its CPU with that softirq time. Every CPU figure is per second of the measured run, which autocannon, stopping on its one-second sampler, can stretch past `--duration` (a 10 s run can last 11 s). The runner writes `report.md` and `raw.json` under `benchmark/results/nest-<timestamp>/` with the ratios Nest's benchmark prints (adapter over raw server, adapter over adapter) and the adapter-versus-adapter ratios across runtimes. Whatever answers on the port is what gets measured, so a server starts only on a free port, a run whose server exits before its measurement ends fails instead of reporting whatever answered in its place, and a run stopped by a signal (`SIGINT`, `SIGTERM`, `SIGHUP`, sent to the runner alone or to its group) takes its server down with it.

In [nest-autocannon](results/nest-autocannon/report.md), platform-bun on Bun serves 194,193 requests/s, platform-node 172,841 on Node 26 and 153,606 on Bun, every server saturated once the softirq time of its CPUs is counted; the full matrix is in its report, and the servers' kernel time in this benchmark in [VALIDATION.md](../VALIDATION.md#benchmark).

## Cross-checks with other load generators

Both runners can measure with a second load generator, to check autocannon's ranking against tools that work differently. The controllers benchmark, which does not pipeline, runs with [oha](https://github.com/hatoo/oha), written in Rust. Nest's pipelined benchmark runs with [wrk](https://github.com/wg/wrk), written in C. `bun install` installs neither:

```sh
cargo install oha --version 1.16.0 --locked           # or a package manager's oha
git clone https://github.com/wg/wrk && make -C wrk    # wrk 4.2.0, or a package manager's wrk

bun benchmark/run.ts --targets bun,node-bun,node-node --generator oha --oha "$(command -v oha)"
node benchmark/nest/main.mjs --targets nest-bun@bun,nest-node@node,nest-node@bun,bun@bun,node@node --generator wrk --wrk "$(command -v wrk)" --threads 4
```

`--oha` and `--wrk` (or `BENCH_OHA` and `BENCH_WRK`) default to `oha` and `wrk` on `PATH`. The report names the generator, its version and its path, and its reproduce line selects it again. All other conditions match the autocannon runs: the same connections, durations, warm-ups, rounds and CPU pinning, with the generator on the load generator's CPUs. Where the tools differ, each report says so:

- **oha** has one request in flight per connection, as autocannon does here, and waits at the end of a run for the requests in flight. It does not check response bodies under load. Bodies, statuses and media types are checked before each route's warm-up, and the report's mismatch column reads "not checked". Non-2xx answers (redirects among them: oha is told not to follow them) and transport errors invalidate a trial, as with autocannon; figures oha leaves incomplete, or prints out of range (a negative count or rate, say), stop the run.
- **wrk** sends each connection's 10 requests as one batch, and the next batch once all 10 responses have arrived. autocannon instead sends a new request as each response arrives: both keep 10 requests per connection pipelined, but the server sees them arrive differently. wrk splits the connections between its threads, so `--threads` must divide `--connections`, and it runs whole seconds only.
  - Its latency is not reported. Under pipelining it times batches rather than requests, and its coordinated-omission correction, made at the interval of one request, corrupts the distribution: its 90th and 99th percentiles read 0.
  - It counts 4xx and 5xx answers but not redirects, so the report's status column reads 4xx–5xx. Each server's reply is checked before its runs.
  - As with autocannon, this runner reports socket errors, timeouts and error answers in that column rather than stopping, as Nest's benchmark prints them. A wrk that exits with an error, or prints incomplete or out-of-range figures, stops the run.
  - The generator CPU is wrk's own, read from the runner's exited child processes.

The cross-checks are [controllers-oha](results/controllers-oha/report.md) and [nest-wrk](results/nest-wrk/report.md), under the conditions of the autocannon runs. oha ranks the controllers benchmark's targets as autocannon does on every route, and wrk ranks Nest's adapters as autocannon does but for two neighbours, platform-node on Bun and platform-fastify on Node, which swap places (2.5% apart, their ranges overlapping, under autocannon). The margins move by a few points: platform-bun on Bun leads platform-node on Node by 26–29% under oha and 11.6% under wrk (22–25% and 12.4% under autocannon), and platform-node on Bun by 12–17% and 20.2% (11–20% and 26.4%).

## Reports and the chart

A report is rendered from its run's `raw.json`, so it can be rendered again, from any run either runner wrote:

```sh
node benchmark/render.mjs benchmark/results/controllers-autocannon benchmark/results/nest-wrk
```

The README's chart is drawn from a run of each benchmark, by default `controllers-autocannon` and `nest-autocannon`, as one SVG file per color scheme (`results/chart-light.svg` and `results/chart-dark.svg`):

```sh
node benchmark/chart.mjs [--controllers DIR] [--nest DIR] [--output DIR]
```

## Runtimes and tools

CI and `packageManager` pin Bun 1.4.4. The committed runs used a Bun 1.4.4 binary downloaded from its tagged release and checked against the release's SHA-256 ([validation/bun-1.4.4.json](../validation/bun-1.4.4.json)), wrk 4.2.0 built from its source and oha 1.16.0 from `cargo install`, all in the repository's git-ignored `.tools/` directory, where their reports name them; pass `--bun`, `--wrk` and `--oha` to select your own when reproducing.

### Before the rewrite

The transports the rewrite replaced, a `Bun.listen` socket backend and a first `Bun.serve` bridge, measured 32–39% and 19–24% slower than `platform-node` on the same Bun 1.4.4 runtime. Those targets no longer exist, and their runs (on Bun 1.4.3 and 1.4.4, with Node 22) are not part of this repository.
