# Security policy

platform-bun is experimental and is not published to npm. It is not meant for
production use yet, but security reports are welcome, above all for the request
path: the `Bun.serve()` transport, body parsing, static files and uploads.

## Supported versions

Only the latest commit on `main` is supported. There are no releases yet.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub instead:
open the repository's **Security** tab and choose **Report a vulnerability**
([direct link](https://github.com/iiAku/platform-bun/security/advisories/new)).
Only the maintainers can read the report.

Include the commit you tested, your Bun and NestJS versions, a minimal
reproduction, and the impact you expect. If `@nestjs/platform-node` running on
Node behaves differently for the same input, say so: that difference is often
the clearest evidence.

This project is maintained in spare time, so responses are best effort. A
confirmed issue is fixed on `main` and disclosed through a GitHub security
advisory, crediting the reporter unless they prefer otherwise.

## Scope

In scope: the code in this repository, its build and its packaging.

Out of scope: vulnerabilities in Bun, NestJS or a dependency themselves (report
those upstream, and tell us if this adapter makes one reachable), and the
behaviors that [COMPATIBILITY.md](./COMPATIBILITY.md) documents as deliberate
differences from `node:http`.
