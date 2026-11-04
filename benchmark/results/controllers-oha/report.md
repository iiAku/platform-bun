# Controllers benchmark: platform-bun against platform-node

Real Nest 12.3.3 controllers answer every Nest request, on every adapter with the same routes, methods, payloads and response bodies; no static route responses or application bypasses are used. Run on 2026-11-04 at 15:07 UTC: 54 of 54 measured trials completed (complete). 100 connections, pipelining 1, oha in a separate process, waiting at the end of a run for the requests in flight. Each target ran 3 rounds of a 2 s warm-up then 5 s measured per route, the target order rotating between rounds and the servers running one at a time; the figures are medians over the rounds.

## Requests per second

| Target | GET `/` | GET `/users/42` | POST `/echo` |
|---|---:|---:|---:|
| platform-bun on Bun | 169,366 | 160,699 | 129,313 |
| platform-node on Node | 132,381 | 127,819 | 100,558 |
| platform-node on Bun | 145,820 | 137,410 | 115,449 |
| platform-fastify on Bun | 131,055 | 121,504 | 102,612 |
| platform-express on Bun | 113,685 | 104,148 | 79,501 |
| Bun.serve() on Bun (no Nest) | 201,376 | 192,752 | 164,990 |

platform-bun on Bun against the other Nest adapters:

| Target | GET `/` | GET `/users/42` | POST `/echo` |
|---|---:|---:|---:|
| platform-node on Node | +27.9% | +25.7% | +28.6% |
| platform-node on Bun | +16.1% | +16.9% | +12.0% |
| platform-fastify on Bun | +29.2% | +32.3% | +26.0% |
| platform-express on Bun | +49.0% | +54.3% | +62.7% |

## Details

| Target | Route | Median req/s | Min–max req/s | Median p99 ms | Errors / non-2xx / body mismatches |
|---|---|---:|---:|---:|---:|
| platform-bun on Bun | GET `/` | 169,366 | 161,538–171,434 | 0.96 | 0 / 0 / not checked |
| platform-bun on Bun | GET `/users/42` | 160,699 | 154,916–164,525 | 0.99 | 0 / 0 / not checked |
| platform-bun on Bun | POST `/echo` | 129,313 | 122,334–134,523 | 1.14 | 0 / 0 / not checked |
| platform-node on Node | GET `/` | 132,381 | 131,308–134,658 | 0.92 | 0 / 0 / not checked |
| platform-node on Node | GET `/users/42` | 127,819 | 126,813–129,925 | 0.96 | 0 / 0 / not checked |
| platform-node on Node | POST `/echo` | 100,558 | 100,441–101,288 | 1.21 | 0 / 0 / not checked |
| platform-node on Bun | GET `/` | 145,820 | 143,934–145,999 | 0.97 | 0 / 0 / not checked |
| platform-node on Bun | GET `/users/42` | 137,410 | 136,932–143,237 | 1.05 | 0 / 0 / not checked |
| platform-node on Bun | POST `/echo` | 115,449 | 113,834–115,869 | 1.2 | 0 / 0 / not checked |
| platform-fastify on Bun | GET `/` | 131,055 | 122,251–131,468 | 1.13 | 0 / 0 / not checked |
| platform-fastify on Bun | GET `/users/42` | 121,504 | 119,819–126,437 | 1.24 | 0 / 0 / not checked |
| platform-fastify on Bun | POST `/echo` | 102,612 | 101,850–103,749 | 1.37 | 0 / 0 / not checked |
| platform-express on Bun | GET `/` | 113,685 | 103,730–116,442 | 1.34 | 0 / 0 / not checked |
| platform-express on Bun | GET `/users/42` | 104,148 | 99,938–108,738 | 1.42 | 0 / 0 / not checked |
| platform-express on Bun | POST `/echo` | 79,501 | 76,830–82,542 | 1.76 | 0 / 0 / not checked |
| Bun.serve() on Bun (no Nest) | GET `/` | 201,376 | 186,868–205,628 | 1.05 | 0 / 0 / not checked |
| Bun.serve() on Bun (no Nest) | GET `/users/42` | 192,752 | 188,028–200,542 | 1.09 | 0 / 0 / not checked |
| Bun.serve() on Bun (no Nest) | POST `/echo` | 164,990 | 162,733–165,566 | 0.85 | 0 / 0 / not checked |

## Conditions

- Host: AMD Ryzen 9 9900X 12-Core Processor; 12 cores, 12 logical CPUs (SMT off); 60 GiB; linux 7.1.12-357.current x64; CPU governor performance (performance); load average at start 1.8, 1.83, 1.81.
- Runtimes: Node v26.13.0 (`~/.nvm/versions/node/v26.13.0/bin/node`), Bun 1.4.4 (`.tools/bun-1.4.4/bun`). Load generator: oha 1.16.0 (`.tools/oha/bin/oha`).
- Packages: @nestjs/core 12.3.3, @nestjs/common 12.3.3, @nestjs/platform-node 12.3.3, @nestjs/platform-express 12.3.3, @nestjs/platform-fastify 12.3.3, express 5.3.0, fastify 5.12.8, @nestjs/platform-bun 0.1.0 (this tree, built).
- CPU pinning (taskset, the same for every target): servers on CPUs 0,1,2,3; load generator on CPUs 4,5,6,7,8,9,10,11.
- Runtimes the servers reported: platform-bun on Bun: Bun 1.4.4; platform-node on Node: Node v26.13.0; platform-node on Bun: Bun 1.4.4; platform-fastify on Bun: Bun 1.4.4; platform-express on Bun: Bun 1.4.4; Bun.serve() on Bun (no Nest): Bun 1.4.4.

## Limits

These are local HTTP/1.1 loopback microbenchmarks, with client and server sharing this machine. They measure these three workloads, not production application performance. Background load, CPU scheduling, runtime warm-up and the load generator can affect results. Min–max across rounds is shown; no statistical significance is claimed. POST returns Nest’s default 201. Express uses its default text/html media type for the returned string; the other adapters use text/plain, as in the original PR workload. `Bun.serve()` alone, if measured, is a transport ceiling with no Nest pipeline and is not an equivalent application baseline.

Every scenario is checked for status, exact body and media type before warm-up. oha does not check response bodies during load; non-2xx answers and transport errors, timeouts among them, invalidate a trial. All raw histograms, counters, trial order, timings, preflight response headers, server CPU samples (Linux) and host metadata are in `raw.json`.

## Reproduce

```sh
bun install --frozen-lockfile
bun run build
bun benchmark/run.ts --duration 5 --warmup 2 --rounds 3 --connections 100 --workers 4 --targets bun,node-bun,node-node,express-bun,fastify-bun,raw-bun --node ~/.nvm/versions/node/v26.13.0/bin/node --bun .tools/bun-1.4.4/bun --generator oha --oha .tools/oha/bin/oha
```
