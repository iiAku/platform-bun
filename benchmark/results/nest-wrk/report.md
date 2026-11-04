# Nest's benchmark: platform-bun against platform-node

Nest's own benchmark (`tools/benchmarks` at commit 59f33793), run on 2026-11-04 at 15:14 UTC: every server answers GET `/` with "Hello world!" (Nest with `bodyParser: false` and `logger: false`) to 100 connections with pipelining 10, one server at a time. The load generator is wrk with 4 threads, in a child process: each connection sends its 10 requests as one batch, and its next batch once all 10 responses have arrived, where autocannon sends a request as each response arrives. Each target ran 3 rounds of a 10 s warm-up then 10 s measured, the target order rotating between rounds; the figures are medians over the rounds.

## Requests per second

| Target | Median req/s | Min–max req/s |
|---|---:|---:|
| platform-bun on Bun | 207,084 | 203,675–208,722 |
| platform-node on Node | 185,615 | 182,824–187,437 |
| platform-node on Bun | 172,335 | 172,127–175,467 |
| platform-fastify on Node | 164,183 | 163,051–165,275 |
| platform-fastify on Bun | 146,678 | 146,049–148,770 |
| platform-express on Node | 105,592 | 104,750–106,546 |
| platform-express on Bun | 131,812 | 129,245–131,845 |
| Bun.serve() on Bun (no Nest) | 259,407 | 258,347–259,996 |
| node:http on Node (no Nest) | 203,024 | 202,709–204,017 |
| node:http on Bun (no Nest) | 197,858 | 195,927–202,500 |
| Fastify on Node (no Nest) | 192,787 | 191,059–195,454 |
| Fastify on Bun (no Nest) | 179,781 | 178,579–180,910 |
| Express on Node (no Nest) | 115,274 | 113,849–115,436 |
| Express on Bun (no Nest) | 145,145 | 143,869–146,305 |

platform-bun on Bun against the other Nest adapters:

- platform-node on Node: +11.6% (207,084 against 185,615 requests/s)
- platform-node on Bun: +20.2% (207,084 against 172,335 requests/s)
- platform-fastify on Node: +26.1% (207,084 against 164,183 requests/s)
- platform-fastify on Bun: +41.2% (207,084 against 146,678 requests/s)
- platform-express on Node: +96.1% (207,084 against 105,592 requests/s)
- platform-express on Bun: +57.1% (207,084 against 131,812 requests/s)

Each Nest adapter on Bun against itself on Node:

- platform-node: −7.2% (172,335 against 185,615 requests/s)
- platform-fastify: −10.7% (146,678 against 164,183 requests/s)
- platform-express: +24.8% (131,812 against 105,592 requests/s)

Each Nest adapter against its server without Nest, on the same runtime:

- platform-bun on Bun against Bun.serve() on Bun: −20.2% (207,084 against 259,407 requests/s)
- platform-node on Node against node:http on Node: −8.6% (185,615 against 203,024 requests/s)
- platform-node on Bun against node:http on Bun: −12.9% (172,335 against 197,858 requests/s)
- platform-fastify on Node against Fastify on Node: −14.8% (164,183 against 192,787 requests/s)
- platform-fastify on Bun against Fastify on Bun: −18.4% (146,678 against 179,781 requests/s)
- platform-express on Node against Express on Node: −8.4% (105,592 against 115,274 requests/s)
- platform-express on Bun against Express on Bun: −9.2% (131,812 against 145,145 requests/s)

## Server and load generator

| Target | Server CPU cores | Softirq cores on server CPUs | Generator CPU cores | Latency avg ms | p99 ms | Throughput | Errors / timeouts / 4xx–5xx |
|---|---:|---:|---:|---:|---:|---:|---:|
| platform-bun on Bun | 0.66 | 0.38 | 0.49 | n/a | n/a | 25.5 MB/s | 0 / 0 / 0 |
| platform-node on Node | 0.68 | 0.32 | 0.43 | n/a | n/a | 31.2 MB/s | 0 / 0 / 0 |
| platform-node on Bun | 0.68 | 0.35 | 0.46 | n/a | n/a | 28.9 MB/s | 0 / 0 / 0 |
| platform-fastify on Node | 0.71 | 0.30 | 0.40 | n/a | n/a | 27.7 MB/s | 0 / 0 / 0 |
| platform-fastify on Bun | 0.72 | 0.31 | 0.42 | n/a | n/a | 24.8 MB/s | 0 / 0 / 0 |
| platform-express on Node | 0.81 | 0.20 | 0.27 | n/a | n/a | 24.1 MB/s | 0 / 0 / 0 |
| platform-express on Bun | 0.74 | 0.29 | 0.39 | n/a | n/a | 30.0 MB/s | 0 / 0 / 0 |
| Bun.serve() on Bun (no Nest) | 0.57 | 0.43 | 0.55 | n/a | n/a | 31.9 MB/s | 0 / 0 / 0 |
| node:http on Node (no Nest) | 0.65 | 0.36 | 0.47 | n/a | n/a | 34.1 MB/s | 0 / 0 / 0 |
| node:http on Bun (no Nest) | 0.66 | 0.36 | 0.49 | n/a | n/a | 33.2 MB/s | 0 / 0 / 0 |
| Fastify on Node (no Nest) | 0.66 | 0.34 | 0.45 | n/a | n/a | 32.5 MB/s | 0 / 0 / 0 |
| Fastify on Bun (no Nest) | 0.68 | 0.35 | 0.47 | n/a | n/a | 30.3 MB/s | 0 / 0 / 0 |
| Express on Node (no Nest) | 0.79 | 0.21 | 0.28 | n/a | n/a | 26.3 MB/s | 0 / 0 / 0 |
| Express on Bun (no Nest) | 0.72 | 0.31 | 0.42 | n/a | n/a | 33.1 MB/s | 0 / 0 / 0 |

The targets marked "(no Nest)" are the servers alone, answering with the same body; `Bun.serve()` alone is the runtime's ceiling. Server CPU is the server process's own time. Softirq is the kernel's time on the server's CPUs outside any process: on loopback, mostly delivering the server's responses to the load generator and waking it, which a kernel that accounts IRQ time on its own (`CONFIG_IRQ_TIME_ACCOUNTING`) books to no process. A single-threaded server is saturated when the two add up to about one core (helper threads, such as a garbage collector's, add a little to the first); when the generator's CPU cores approach one, or the ceiling target is as fast as the adapters, the generator is the limit. This is a loopback microbenchmark on one machine, the load generator sharing it: it ranks adapters on this workload and nothing else.

wrk's latency is not reported: under pipelining it times batches rather than requests, and corrects its samples for coordinated omission at the interval of a request, which puts samples below its own minimum (its 90th and 99th percentiles then read 0). wrk counts 4xx and 5xx answers but not redirects; each server's reply is checked, status and body, before its runs.

## Conditions

- Host: AMD Ryzen 9 9900X 12-Core Processor; 12 cores, 12 logical CPUs (SMT off); 60 GiB; linux 7.1.12-357.current x64; CPU governor performance (performance); load average at start 2.07, 2.01, 1.9.
- Runtimes: Node v26.13.0 (`~/.nvm/versions/node/v26.13.0/bin/node`), Bun 1.4.4 (`.tools/bun-1.4.4/bun`). Load generator: wrk 4.2.0 [epoll] (`.tools/wrk/wrk`).
- Packages: @nestjs/core 12.3.3, @nestjs/common 12.3.3, @nestjs/platform-node 12.3.3, @nestjs/platform-express 12.3.3, @nestjs/platform-fastify 12.3.3, express 5.3.0, fastify 5.12.8, @nestjs/platform-bun 0.1.0 (this tree, built).
- CPU pinning (taskset, the same for every target): servers on CPUs 0,1,2,3; load generator on CPUs 4,5,6,7,8,9,10,11.

## Reproduce

```sh
bun run build
node benchmark/nest/main.mjs --targets node@node,nest-node@node,express@node,nest-express@node,fastify@node,nest-fastify@node,node@bun,bun@bun,nest-node@bun,nest-bun@bun,express@bun,nest-express@bun,fastify@bun,nest-fastify@bun --rounds 3 --connections 100 --duration 10 --pipelining 10 --node ~/.nvm/versions/node/v26.13.0/bin/node --bun .tools/bun-1.4.4/bun --generator wrk --wrk .tools/wrk/wrk --threads 4
```
