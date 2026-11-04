# Nest's benchmark: platform-bun against platform-node

Nest's own benchmark (`tools/benchmarks` at commit 59f33793), run on 2026-11-04 at 14:52 UTC: every server answers GET `/` with "Hello world!" (Nest with `bodyParser: false` and `logger: false`) to 100 connections with pipelining 10, one server at a time. The load generator is autocannon, in the runner process. Each target ran 3 rounds of a 10 s warm-up then 10 s measured, the target order rotating between rounds; the figures are medians over the rounds.

## Requests per second

| Target | Median req/s | Min–max req/s |
|---|---:|---:|
| platform-bun on Bun | 194,193 | 188,119–196,579 |
| platform-node on Node | 172,841 | 172,748–175,098 |
| platform-node on Bun | 153,606 | 152,919–161,367 |
| platform-fastify on Node | 157,504 | 157,015–159,366 |
| platform-fastify on Bun | 127,244 | 125,492–130,697 |
| platform-express on Node | 102,275 | 100,314–102,467 |
| platform-express on Bun | 114,505 | 113,743–117,844 |
| Bun.serve() on Bun (no Nest) | 281,030 | 274,397–299,532 |
| node:http on Node (no Nest) | 200,675 | 195,706–203,875 |
| node:http on Bun (no Nest) | 185,792 | 184,035–186,769 |
| Fastify on Node (no Nest) | 187,107 | 186,502–191,040 |
| Fastify on Bun (no Nest) | 161,658 | 161,135–164,393 |
| Express on Node (no Nest) | 109,152 | 108,512–109,559 |
| Express on Bun (no Nest) | 126,391 | 123,814–126,650 |

platform-bun on Bun against the other Nest adapters:

- platform-node on Node: +12.4% (194,193 against 172,841 requests/s)
- platform-node on Bun: +26.4% (194,193 against 153,606 requests/s)
- platform-fastify on Node: +23.3% (194,193 against 157,504 requests/s)
- platform-fastify on Bun: +52.6% (194,193 against 127,244 requests/s)
- platform-express on Node: +89.9% (194,193 against 102,275 requests/s)
- platform-express on Bun: +69.6% (194,193 against 114,505 requests/s)

Each Nest adapter on Bun against itself on Node:

- platform-node: −11.1% (153,606 against 172,841 requests/s)
- platform-fastify: −19.2% (127,244 against 157,504 requests/s)
- platform-express: +12.0% (114,505 against 102,275 requests/s)

Each Nest adapter against its server without Nest, on the same runtime:

- platform-bun on Bun against Bun.serve() on Bun: −30.9% (194,193 against 281,030 requests/s)
- platform-node on Node against node:http on Node: −13.9% (172,841 against 200,675 requests/s)
- platform-node on Bun against node:http on Bun: −17.3% (153,606 against 185,792 requests/s)
- platform-fastify on Node against Fastify on Node: −15.8% (157,504 against 187,107 requests/s)
- platform-fastify on Bun against Fastify on Bun: −21.3% (127,244 against 161,658 requests/s)
- platform-express on Node against Express on Node: −6.3% (102,275 against 109,152 requests/s)
- platform-express on Bun against Express on Bun: −9.4% (114,505 against 126,391 requests/s)

## Server and load generator

| Target | Server CPU cores | Softirq cores on server CPUs | Generator CPU cores | Latency avg ms | p99 ms | Throughput | Errors / timeouts / non-2xx |
|---|---:|---:|---:|---:|---:|---:|---:|
| platform-bun on Bun | 0.60 | 0.44 | 0.80 | 4.65 | 9 | 23.9 MB/s | 0 / 0 / 0 |
| platform-node on Node | 0.64 | 0.36 | 0.74 | 5.23 | 8 | 29.0 MB/s | 0 / 0 / 0 |
| platform-node on Bun | 0.62 | 0.41 | 0.75 | 5.96 | 11 | 25.8 MB/s | 0 / 0 / 0 |
| platform-fastify on Node | 0.67 | 0.34 | 0.68 | 5.82 | 9 | 26.6 MB/s | 0 / 0 / 0 |
| platform-fastify on Bun | 0.61 | 0.41 | 0.66 | 7.38 | 14 | 21.5 MB/s | 0 / 0 / 0 |
| platform-express on Node | 0.76 | 0.24 | 0.48 | 9.31 | 15 | 23.3 MB/s | 0 / 0 / 0 |
| platform-express on Bun | 0.63 | 0.40 | 0.64 | 8.21 | 16 | 26.1 MB/s | 0 / 0 / 0 |
| Bun.serve() on Bun (no Nest) | 0.56 | 0.44 | 0.85 | 3.04 | 6 | 34.6 MB/s | 0 / 0 / 0 |
| node:http on Node (no Nest) | 0.62 | 0.38 | 0.79 | 4.45 | 7 | 33.7 MB/s | 0 / 0 / 0 |
| node:http on Bun (no Nest) | 0.60 | 0.43 | 0.83 | 4.83 | 9 | 31.2 MB/s | 0 / 0 / 0 |
| Fastify on Node (no Nest) | 0.64 | 0.37 | 0.75 | 4.79 | 8 | 31.6 MB/s | 0 / 0 / 0 |
| Fastify on Bun (no Nest) | 0.62 | 0.40 | 0.77 | 5.68 | 11 | 27.3 MB/s | 0 / 0 / 0 |
| Express on Node (no Nest) | 0.74 | 0.26 | 0.52 | 8.65 | 14 | 24.9 MB/s | 0 / 0 / 0 |
| Express on Bun (no Nest) | 0.61 | 0.42 | 0.69 | 7.45 | 15 | 28.8 MB/s | 0 / 0 / 0 |

The targets marked "(no Nest)" are the servers alone, answering with the same body; `Bun.serve()` alone is the runtime's ceiling. Server CPU is the server process's own time. Softirq is the kernel's time on the server's CPUs outside any process: on loopback, mostly delivering the server's responses to the load generator and waking it, which a kernel that accounts IRQ time on its own (`CONFIG_IRQ_TIME_ACCOUNTING`) books to no process. A single-threaded server is saturated when the two add up to about one core (helper threads, such as a garbage collector's, add a little to the first); when the generator's CPU cores approach one, or the ceiling target is as fast as the adapters, the generator is the limit. This is a loopback microbenchmark on one machine, the load generator sharing it: it ranks adapters on this workload and nothing else.

## Conditions

- Host: AMD Ryzen 9 9900X 12-Core Processor; 12 cores, 12 logical CPUs (SMT off); 60 GiB; linux 7.1.12-357.current x64; CPU governor performance (performance); load average at start 2.34, 1.93, 1.7.
- Runtimes: Node v26.13.0 (`~/.nvm/versions/node/v26.13.0/bin/node`), Bun 1.4.4 (`.tools/bun-1.4.4/bun`). Load generator: autocannon 8.0.0 on Node v26.13.0 (`~/.nvm/versions/node/v26.13.0/bin/node`).
- Packages: @nestjs/core 12.3.3, @nestjs/common 12.3.3, @nestjs/platform-node 12.3.3, @nestjs/platform-express 12.3.3, @nestjs/platform-fastify 12.3.3, express 5.3.0, fastify 5.12.8, @nestjs/platform-bun 0.1.0 (this tree, built).
- CPU pinning (taskset, the same for every target): servers on CPUs 0,1,2,3; load generator on CPUs 4,5,6,7,8,9,10,11.

## Reproduce

```sh
bun run build
node benchmark/nest/main.mjs --targets node@node,nest-node@node,express@node,nest-express@node,fastify@node,nest-fastify@node,node@bun,bun@bun,nest-node@bun,nest-bun@bun,express@bun,nest-express@bun,fastify@bun,nest-fastify@bun --rounds 3 --connections 100 --duration 10 --pipelining 10 --node ~/.nvm/versions/node/v26.13.0/bin/node --bun .tools/bun-1.4.4/bun
```
