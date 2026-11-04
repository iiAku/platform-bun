## What and why

<!-- What this changes and why. Link the issue it addresses, if any. -->

## Checklist

- [ ] `bun run test` passes locally, with Node 26 on `PATH`
- [ ] Behavior changes come with tests (transport changes with a contract test that fails without them)
- [ ] A new difference from `node:http` is asserted in the differential suite and listed in `COMPATIBILITY.md`
- [ ] Performance claims include a benchmark run and its conditions (CPU, SMT, power profile, versions, commit)
- [ ] Docs updated where this changes what they say
