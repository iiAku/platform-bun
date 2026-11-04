# Controllers benchmark: platform-bun against platform-node

Real Nest 12.3.3 controllers answer every Nest request, on every adapter with the same routes, methods, payloads and response bodies; no static route responses or application bypasses are used. Run on 2026-11-04 at 14:45 UTC: 54 of 54 measured trials completed (complete). 100 connections, pipelining 1, 4 Node autocannon load workers in a separate process. Each target ran 3 rounds of a 2 s warm-up then 5 s measured per route, the target order rotating between rounds and the servers running one at a time; the figures are medians over the rounds.

## Requests per second

| Target | GET `/` | GET `/users/42` | POST `/echo` |
|---|---:|---:|---:|
| platform-bun on Bun | 168,973 | 164,032 | 126,202 |
| platform-node on Node | 138,950 | 131,014 | 102,458 |
| platform-node on Bun | 146,138 | 136,205 | 113,978 |
| platform-fastify on Bun | 129,677 | 124,378 | 105,043 |
| platform-express on Bun | 114,925 | 108,986 | 82,234 |
| Bun.serve() on Bun (no Nest) | 202,790 | 196,134 | 166,643 |

platform-bun on Bun against the other Nest adapters:

| Target | GET `/` | GET `/users/42` | POST `/echo` |
|---|---:|---:|---:|
| platform-node on Node | +21.6% | +25.2% | +23.2% |
| platform-node on Bun | +15.6% | +20.4% | +10.7% |
| platform-fastify on Bun | +30.3% | +31.9% | +20.1% |
| platform-express on Bun | +47.0% | +50.5% | +53.5% |

## Details

| Target | Route | Median req/s | Min–max req/s | Median p99 ms | Errors / non-2xx / body mismatches |
|---|---|---:|---:|---:|---:|
| platform-bun on Bun | GET `/` | 168,973 | 162,522–171,686 | 0 | 0 / 0 / 0 |
| platform-bun on Bun | GET `/users/42` | 164,032 | 162,394–166,950 | 1 | 0 / 0 / 0 |
| platform-bun on Bun | POST `/echo` | 126,202 | 119,725–129,786 | 1 | 0 / 0 / 0 |
| platform-node on Node | GET `/` | 138,950 | 136,512–144,141 | 0 | 0 / 0 / 0 |
| platform-node on Node | GET `/users/42` | 131,014 | 128,518–136,896 | 0 | 0 / 0 / 0 |
| platform-node on Node | POST `/echo` | 102,458 | 99,194–103,725 | 1 | 0 / 0 / 0 |
| platform-node on Bun | GET `/` | 146,138 | 134,086–151,027 | 1 | 0 / 0 / 0 |
| platform-node on Bun | GET `/users/42` | 136,205 | 129,242–141,146 | 1 | 0 / 0 / 0 |
| platform-node on Bun | POST `/echo` | 113,978 | 113,338–117,459 | 1 | 0 / 0 / 0 |
| platform-fastify on Bun | GET `/` | 129,677 | 129,510–134,099 | 1 | 0 / 0 / 0 |
| platform-fastify on Bun | GET `/users/42` | 124,378 | 123,987–129,120 | 1 | 0 / 0 / 0 |
| platform-fastify on Bun | POST `/echo` | 105,043 | 102,854–108,666 | 1 | 0 / 0 / 0 |
| platform-express on Bun | GET `/` | 114,925 | 114,477–114,938 | 1 | 0 / 0 / 0 |
| platform-express on Bun | GET `/users/42` | 108,986 | 107,616–108,986 | 1 | 0 / 0 / 0 |
| platform-express on Bun | POST `/echo` | 82,234 | 78,189–82,861 | 1 | 0 / 0 / 0 |
| Bun.serve() on Bun (no Nest) | GET `/` | 202,790 | 196,390–211,213 | 1 | 0 / 0 / 0 |
| Bun.serve() on Bun (no Nest) | GET `/users/42` | 196,134 | 187,558–202,714 | 1 | 0 / 0 / 0 |
| Bun.serve() on Bun (no Nest) | POST `/echo` | 166,643 | 166,490–167,181 | 0 | 0 / 0 / 0 |

## Conditions

- Host: AMD Ryzen 9 9900X 12-Core Processor; 12 cores, 12 logical CPUs (SMT off); 60 GiB; linux 7.1.12-357.current x64; CPU governor performance (performance); load average at start 0.52, 0.76, 1.34.
- Runtimes: Node v26.13.0 (`~/.nvm/versions/node/v26.13.0/bin/node`), Bun 1.4.4 (`.tools/bun-1.4.4/bun`). Load generator: autocannon 8.0.0 on Node v26.13.0 (`~/.nvm/versions/node/v26.13.0/bin/node`).
- Packages: @nestjs/core 12.3.3, @nestjs/common 12.3.3, @nestjs/platform-node 12.3.3, @nestjs/platform-express 12.3.3, @nestjs/platform-fastify 12.3.3, express 5.3.0, fastify 5.12.8, @nestjs/platform-bun 0.1.0 (this tree, built).
- CPU pinning (taskset, the same for every target): servers on CPUs 0,1,2,3; load generator on CPUs 4,5,6,7,8,9,10,11.
- Runtimes the servers reported: platform-bun on Bun: Bun 1.4.4; platform-node on Node: Node v26.13.0; platform-node on Bun: Bun 1.4.4; platform-fastify on Bun: Bun 1.4.4; platform-express on Bun: Bun 1.4.4; Bun.serve() on Bun (no Nest): Bun 1.4.4.

## Limits

These are local HTTP/1.1 loopback microbenchmarks, with client and server sharing this machine. They measure these three workloads, not production application performance. Background load, CPU scheduling, runtime warm-up and the load generator can affect results. Min–max across rounds is shown; no statistical significance is claimed. POST returns Nest’s default 201. Express uses its default text/html media type for the returned string; the other adapters use text/plain, as in the original PR workload. `Bun.serve()` alone, if measured, is a transport ceiling with no Nest pipeline and is not an equivalent application baseline.

Every scenario is checked for status, exact body and media type before warm-up. Autocannon checks exact response bodies during load; non-2xx, transport errors, timeouts and mismatches invalidate a trial. p99 measurements have whole-millisecond precision. All raw histograms, counters, trial order, timings, preflight response headers, server CPU samples (Linux) and host metadata are in `raw.json`.

## Reproduce

```sh
bun install --frozen-lockfile
bun run build
bun benchmark/run.ts --duration 5 --warmup 2 --rounds 3 --connections 100 --workers 4 --targets bun,node-bun,node-node,express-bun,fastify-bun,raw-bun --node ~/.nvm/versions/node/v26.13.0/bin/node --bun .tools/bun-1.4.4/bun
```
