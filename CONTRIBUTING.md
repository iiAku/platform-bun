# Contributing

Thanks for your interest in platform-bun. The project is experimental: issues
and pull requests are welcome, but expect the API and behavior to keep changing.

- For anything beyond a small fix, open an issue first so the approach can be
  discussed before you spend time on it.
- Report security issues privately, as described in [SECURITY.md](./SECURITY.md),
  not in a public issue.
- Everyone taking part follows the [code of conduct](./CODE_OF_CONDUCT.md).
- Contributions are licensed under the [MIT license](./LICENSE).

## Setup

You need:

- [Bun](https://bun.sh) 1.4.4 (the version `packageManager` pins);
- Node.js 26 on your `PATH`: the differential tests run the published
  `@nestjs/platform-node` in a Node process and compare it with this adapter;
- Linux or macOS.

```sh
git clone https://github.com/iiAku/platform-bun.git
cd platform-bun
bun install --frozen-lockfile   # also installs the git hooks (lefthook)
bun run build
```

## Checks

| Command | What it runs |
| --- | --- |
| `bun run build` | Compiles `src/` to `dist/` (JavaScript and `.d.ts` declarations) with `tsc`. This is `tsc`'s only use: `bun check` emits nothing, and `bun build` writes no declarations |
| `bun run check` | Type-checks with `bun check` |
| `bun run lint` | Lints with `bun lint`, which ships only in Bun canaries: `scripts/bun-canary.sh` installs the canary pinned in `tools/bun-canary` on first use |
| `bun run fmt --check` | Checks formatting (`bun run fmt` rewrites) |
| `bun run test` | The whole suite (about 50 s) |

lefthook runs `check`, `lint` and `fmt` before each commit and the test suite
before each push. CI runs all of them on every pull request.

The suite is organized as follows:

- `test/transport/`: the transport's contract tests, which pin the Node
  behaviors middleware relies on (event order, backpressure, aborts, `close()`,
  keep-alive);
- `test/integration/`: Nest's integration suites run against this adapter, the
  differential suite (`compatibility-differences.spec.ts`) and the middleware
  interop tests (`compression`, `helmet`, `cookie-parser`, `express-session`,
  `express-rate-limit`);
- `test/native.spec.ts` and `test/native/`: the native body-reading paths;
- `test/upstream/`: the unit tests of `@nestjs/platform-node`, ported to this
  adapter (the adapter, router, body parsers, Multer and views);
- `test/benchmark/`: the benchmark runners' own tests. They stand in for oha
  and wrk with fake executables (`test/support/fake-generator.ts`), so neither
  needs to be installed.

## Guidelines

- **Behavior changes come with tests.** A change to the transport needs a
  contract test that fails without it.
- **Differences are asserted, never skipped.** When `Bun.serve()` forces a
  behavior that differs from `node:http`, add an executable expectation to the
  differential suite and a row to [COMPATIBILITY.md](./COMPATIBILITY.md). The
  suite has no skipped or `todo` tests, and should stay that way.
- **Performance claims need measurements.** Run the benchmarks as described in
  [benchmark/README.md](./benchmark/README.md), and report the conditions with
  the numbers: CPU, SMT, power profile, runtime versions and the commit. Don't
  compare runs made under different conditions as if they were paired.
- **Comments explain why.** Keep the Bun or Node behavior a piece of code
  depends on; leave out what the code already says.
- **Commit messages** have a short imperative subject line and a body that says
  what changed, why, and any risk.

## Pull requests

- Keep each pull request to one topic, rebased on `main`.
- Make sure `bun run test` passes locally, with Node 26 on your `PATH`.
- Update [COMPATIBILITY.md](./COMPATIBILITY.md),
  [VALIDATION.md](./VALIDATION.md) or the READMEs when your change affects what
  they say.
