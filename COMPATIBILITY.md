# Compatibility with `@nestjs/platform-node`

This ports the Nest adapter surface from `@nestjs/platform-node@12.3.3`, pinned to
Nest commit `59f33793c616eaf9669e8b81a35aa5f31accc5b4`. The source design and intended
Express middleware support are described in [Nest PR #18063](https://github.com/nestjs/nest/pull/18063).
`node:http` is replaced by `Bun.serve()`: Bun parses HTTP, owns the sockets and
TLS, and hands the application a native `Request` for which this package builds
Node-shaped request and response objects.

```ts
new BunAdapter(); // Bun.serve() with native Request/Response
```

## Transport

`src/transport/bun-http-server.ts` is the whole transport. Per request it
creates:

- A request: a Node `Readable` whose prototype chain is the adapter's request
  class (`BunRequest`, so `IncomingMessage`). `url` and `method` are read from
  the native `Request` up front; `headers`, `rawHeaders`, `headersDistinct`,
  `complete`, `socket` and `signal` are built on first access. The body
  streams from the native body: a body with a `Content-Length` of at most 64 KiB
  is read in one native call, larger and chunked bodies through a reader. The
  package's body parsers read their headers without building `req.headers`
  and take a body of known length in one native call, decoded natively as
  text for the JSON, urlencoded and text parsers when no `verify` hook needs
  the bytes; a `'data'` or `'readable'` listener attached before the parser
  turns that off and the body goes through the stream, as under Node.
- A response: an `EventEmitter` whose prototype chain is the adapter's response
  class (`BunResponse`, so `ServerResponse`) with the `OutgoingMessage` members
  that render to a socket replaced. Headers are kept in a null-prototype store
  (`setHeader`, `appendHeader`, `getHeader(s)`, `removeHeader`, `hasHeader`,
  `writeHead`, `flushHeaders` and `headersSent` follow Node, including the
  `ERR_HTTP_HEADERS_SENT`, `ERR_INVALID_HTTP_TOKEN`, `ERR_INVALID_CHAR` and
  `ERR_HTTP_INVALID_HEADER_VALUE` errors). `end(body)` without a prior `write()`
  becomes one native `Response`. Before the request's handler returns to Bun,
  it runs the microtasks the request queued (`drainMicrotasks()` from
  `bun:jsc`; Bun would run them right after), so a reply that awaited nothing
  pending, as most Nest handlers do, reaches Bun as a `Response` rather than a
  promise. `write()`, `pipe()` and `flushHeaders()` start
  a pull-based `ReadableStream` body: Bun reads it as the socket drains, so
  `write()` returns `false` and `'drain'` follows the client with a 16 KiB
  high-water mark, as with Node's writable streams.
- A connection facade on first access to `req.socket` (`res.socket`,
  `req.connection`): remote and local addresses, `encrypted`, `server`,
  `_httpMessage`, `address()`, `destroy()` (which aborts the request and
  response), and no-op `setTimeout`/`setNoDelay`/`setKeepAlive`/`ref`/`unref`.

The event state of the request and the response (`_events`) is created with
their first listener; Bun's `EventEmitter` and stream methods allow for that,
and `eventNames()` reports none until then, but code reading `_events` directly
finds `undefined` on an object nothing listened to.

Lifecycle events follow Node. A request whose body was consumed is destroyed
right after its `'end'` (its `'close'` can precede the reply, as under Node);
one whose body nobody read gets `'end'` and `'close'` after the response's
`'finish'` and `'close'`. A client that leaves emits `'aborted'` on a request
whose stream was not read to its end (a GET nobody read included, as under
Node), then `'close'` without `'finish'` on the response, then `'close'` on the
request; a client gone before anything watched the request is reported the
same way once something does. `req.destroy()` aborts the request and drops the
response; `res.destroy()` before the reply terminates the connection, mid-body
it errors the stream. `writableEnded`, `writableFinished`, `writableNeedDrain`,
`writableLength`, `closed`, `errored` and `destroyed` are reported. On a chunked
body, `'finish'` and the `write()` callbacks fire once Bun's writer has taken
the chunks (Node's once the kernel has); on a body closed by its declared
length, once it is handed to Bun. Neither means the client has received it.
A one-body reply's `'finish'` fires once its `Response` is handed to Bun,
before Bun writes it: `closeAllConnections()` called from a `'finish'` listener
drops that reply, which Node would have flushed.

The [transport contract tests](test/transport/) exercise these: finish/close
ordering, backpressure against a client that stops reading (through `'drain'`
and through the `write()` callbacks), `Readable.pipe()`, client aborts before
and during a reply, `req.destroy()`, the socket facade, the header API,
`req.signal`, `close()` and `listen()` again after it.

`BunHttpServer` (`getHttpServer()`) is an `EventEmitter` with the `http.Server`
lifecycle API. `close()` lets the connections that were busy finish and keeps
them open until nothing has been in flight for 250 ms: a request a client sends
on one by then, once it has read the reply, is answered (with
`return503OnClosing`, by a `503` that closes the connection). It answers a
connection opened after it with a `503` that closes it (Node refuses the
connection; the port stays bound until `close()` is done, then it is free for
the next `listen()`), and closes idle keep-alive connections.
`closeAllConnections()` destroys the active responses, ends that wait, and
rotates the native listener on the same address, because Bun has no operation
that closes active sockets while retaining its listener. `closeIdleConnections()`,
`getConnections()`, `ref()`/`unref()` and `setTimeout()` exist for
compatibility, as do `timeout`, `headersTimeout` and `requestTimeout`, which
do not configure the Bun listener (on the HTTPS facade too).

`keepAliveTimeout` and `keepAliveTimeoutBuffer` (5000 and 1000 ms, as in Node
26) set the listener's idle timeout: a connection with no request in flight
is closed once they have passed, and, set after `listen()`, they apply to the
connections served from then on. A request in flight is not timed out while
the application produces its reply: a slow handler, or a streamed or SSE body
that goes quiet, keeps its connection. `keepAliveTimeout = 0` keeps idle
connections open, as in Node.

### HTTPS and server identity

Bun performs the TLS handshake and socket I/O. Key/certificate HTTPS, request
protocol metadata, and Nest's HTTPS URL reporting are tested. The HTTPS lifecycle
object is a `tls.Server` facade (never bound) delegating to a `BunHttpServer`,
because Nest detects the URL scheme with `instanceof tls.Server`. Code relying on
the exact `http.Server`/`https.Server` constructor identity must account for the
facades. The tested key/certificate path does not establish support for every
Node `https.ServerOptions` value, TLS extension, certificate-chain inspection
mode, or private TLS method.

## Package surface

The built root entry point retains all 13 runtime exports of the published Node
adapter, including its six multer exports and the `NodeAdapter`, `NodeRequest`,
`NodeResponse`, and `NodeRouter` compatibility names. Bun names are the preferred
API. Node-named adapter, request, router, application, options, and parser-interface
deep paths have re-export shims; the corresponding Node type aliases are retained.

`getType()` returns `"bun"`. Third-party Nest integrations that select a loader or
driver by adapter type must support that value. Preserving the adapter exports
does not automatically update external packages' adapter registries.

## Differences from `node:http`

The [differential suite](test/integration/compatibility-differences.spec.ts)
runs the published adapter in a separate Node process and compares it with this
adapter. Stream framing cases also start bare `Bun.serve()` listeners.

| Trigger | Published adapter on Node | This adapter on Bun 1.4.4 |
| --- | --- | --- |
| `GET *users` or `OPTIONS *` | Adapter returns 404 | Bun's parser returns 400 before JavaScript runs (as it does under the published adapter on Bun). |
| Raw `/a/../admin` | Dot segments remain in `originalUrl` and the routing path | The native request URL has already become `/admin`. |
| Absolute-form `http://original.example/users?x=1` | `originalUrl` retains the full target | Path and query remain; the original authority is lost. |
| Explicit `Content-Length: 0` on 204 | Node transmits the header | Bun removes it from the wire. |
| `HEAD` answered without a `Content-Length` | No framing header | Bun sends `Content-Length: 0`; a length set explicitly is kept. |
| Pipelined requests while a response is pending | Served in order | Bun closes the connection when a further request is buffered while the response of the current one is awaited across an I/O turn; requests answered within the turn are served in order. |
| Streamed body with a declared length | Explicit `Content-Length` is kept | Kept when the body is complete by the time Bun reads it and smaller than 16 KiB: the adapter closes the body as soon as the declared length is in, so a file that arrives in one chunk under 16 KiB keeps its length. A body of 16 KiB or more, or one produced over several turns, is sent chunked, because Bun frames a stream with its length only when the whole queue is under the stream's high-water mark, which the adapter keeps at Node's 16 KiB for backpressure. |
| `GET` with `Content-Length: 0` and a JSON type | The JSON parser sets `req.body = {}` | Bun gives such a request no body; the parser leaves `req.body` undefined. |
| `Connection: keep-alive` and `Keep-Alive: timeout=5` response headers | Sent by Node | Not sent; connections are kept alive by HTTP/1.1 default. |
| Request sent on a connection that was busy when `close()` was called, after its reply | Answered while the connection's keep-alive time runs (6 s by default) | Answered when sent within 250 ms of the last reply; later, the connection is closed. Bun cannot stop listening without closing such a connection, so the port stays bound, answering new connections with a `503`, for as long as the wait lasts. |
| Idle keep-alive connection | Closed 6 s after its last reply (`keepAliveTimeout` plus `keepAliveTimeoutBuffer`) | Closed 8 to 12 s after it. Bun's idle timer ticks every 4 s, and the adapter rounds up, so that a client (a load balancer, say) reusing the connection within the configured time never races its close. Bun cannot count past 255 s: longer settings keep idle connections open. |
| A connection that sends no request | Closed after `headersTimeout` (60 s, checked every 30 s) | Closed after the idle window, 8 to 12 s with the defaults. |
| A client that reads nothing while a one-body reply is written | Node waits for it | Bun's idle timer also runs while it writes a one-body reply, and Bun reports no end of that write to hold the timer off until then: a client that takes nothing for the idle window once the socket buffers are full is disconnected. A client that keeps reading, however slowly, is not, and a streamed body holds the timer off until it ends. |

Further boundaries:

- `rawHeaders` are reconstructed from the native headers, so original casing,
  order, and individual duplicate lines are lost (`Cookie` values are joined with
  `; `). Node keeps only the first `Content-Type`, `Content-Length` or `Host`
  line of a request that repeats one; Bun joins them with `, `, so the parsers
  see the joined value. `httpVersion` is reported as `1.1`; Bun answers HTTP/1.0
  requests as HTTP/1.1.
- `writeContinue()`, `writeProcessing()`, `writeEarlyHints()`, and
  `addTrailers()` do not transmit their informational responses or trailers.
- Final statuses outside 200–599 are rejected by `writeHead()` with
  `ERR_HTTP_INVALID_STATUS_CODE`, because the native `Response` cannot carry
  them. Custom reason phrases are replaced by Bun's standard phrase. Header
  names are sent lower-cased.
- `req.socket` is request-scoped compatibility metadata, not raw TCP access:
  direct socket writes are accepted and dropped, protocol upgrades are not
  supported, and the object differs between keep-alive requests.
- A response that is destroyed before any reply, or errored mid-body, ends the
  connection through an errored body stream, which Bun reports on stderr.
- The `request.aborted` error of a parser's native read (a client leaving
  mid-body) carries `expected` and `length` but no `received` count: Bun does
  not tell how much of the body had arrived.
- Bun stops feeding a request body once its response is out. Under Node the
  body keeps arriving; here a reader still waiting for it sees the request
  aborted (`'aborted'`, `aborted === true`, `complete === false`, `'close'`
  without `'end'`).

`res.end('text')` without a `Content-Type` sends none (the adapter suppresses
Bun's inference for that case), repeated `Set-Cookie` headers stay separate
lines, and other repeated headers are joined with `, `.

## Validation and upgrades

Upstream unit and Nest integration suites cover routing, parser behavior,
response helpers, middleware errors/filters, versioning, CORS, uploads and disk
cleanup, ranged/static files, views, stream cancellation, SSE
backpressure/disconnects, graceful shutdown and lifecycle. The upstream
stream-cancellation scenario runs with an unbounded source against a client that
disconnects; the transport contract tests add a client that stops reading.

[Real middleware tests](test/integration/middleware-interop.spec.ts) compare the
published Node adapter on Bun with this adapter under `compression`, `helmet`,
`cookie-parser`, `express-session`, and `express-rate-limit`. Assertions include
gzip bytes/decompression, security headers, session persistence, signed-cookie
verification/tamper rejection, separate cookies containing an Expires comma, and
a 429 after the request limit.

Passing these suites establishes the tested contracts on pinned versions. It
does not prove universal compatibility with every inherited Node API, middleware,
TLS feature, or external Nest driver. Re-run the contract/differential tests and
benchmarks whenever upgrading Bun or Nest.
