# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project is
experimental: until a release is published, any version may change the API.

## [Unreleased]

## 0.1.0 (not published)

The first experimental version: `@nestjs/platform-node@12.3.3` (Nest commit
`59f33793`) ported to a native `Bun.serve()` transport.

### Added

- `BunAdapter`, `BunRequest`, `BunResponse`, `BunHttpServer` and the
  `NestBunApplication` type, with the upstream `Node*` names exported as
  migration aliases.
- A `Bun.serve()` transport that builds Node-shaped requests and responses over
  the native `Request` and `Response`: Node streams with backpressure,
  `'finish'`/`'close'` ordering, client aborts, `close()` and
  `closeAllConnections()`, and Node's `keepAliveTimeout` and
  `keepAliveTimeoutBuffer`.
- Native body reads for the JSON, URL-encoded, text and raw parsers; large and
  chunked bodies stream.
- HTTPS through a `tls.Server` facade.
- The upstream router, CORS, static files, views, versioning, hooks, and the
  Multer module and interceptors.
- Two benchmarks: the controllers benchmark, the workload of Nest PR #18063
  with real controllers, and Nest's own `tools/benchmarks` as a runtime matrix.
  Each can run its load with a second generator as a cross-check: oha for the
  first, wrk for Nest's pipelined one. Their reports name every target by its
  adapter and runtime, are rendered again from a run's raw data, and give the
  README its chart of platform-bun against platform-node.

### Known differences

[COMPATIBILITY.md](./COMPATIBILITY.md) lists every tested difference from
`@nestjs/platform-node` on Node.
