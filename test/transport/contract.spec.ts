// The Node stream and socket contract of the Bun.serve() transport, as
// middleware (on-finished, compression, send, pipe()) reads it.
import { afterEach, expect, test } from "bun:test";
import {
  IncomingMessage,
  ServerResponse,
  request as httpRequest,
} from "node:http";
import { connect } from "node:net";
import { Readable, finished } from "node:stream";
import {
  BunHttpServer,
  contentTypeHeaders,
  typeHeaders,
} from "../../src/transport/bun-http-server";
import { BunHttpsServer } from "../../src/transport/bun-https-server";
import { READ_NATIVE_BODY } from "../../src/transport/native-request";
import { json } from "../../src/body-parser/body-parser";

const noop = () => {};

let server: BunHttpServer | undefined;
afterEach(async () => {
  await new Promise<void>(
    (resolve) => server?.close(() => resolve()) ?? resolve(),
  );
  server = undefined;
});

async function start(
  listener: (req: IncomingMessage, res: ServerResponse) => void,
) {
  server = new BunHttpServer(listener);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

function defer<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test("a one-shot reply emits 'finish' then 'close', closing the request last", async () => {
  const events: string[] = [];
  const done = defer();
  const port = await start((req, res) => {
    res.on("finish", () => {
      events.push(
        `finish ended=${res.writableEnded} finished=${res.writableFinished}`,
      );
    });
    res.on("close", () => {
      events.push(`res close closed=${res.closed} destroyed=${res.destroyed}`);
    });
    req.on("close", () => {
      events.push(
        `req close destroyed=${req.destroyed} complete=${req.complete}`,
      );
      done.resolve();
    });
    events.push(`before ended=${res.writableEnded} sent=${res.headersSent}`);
    res.end("ok");
    events.push(
      `after ended=${res.writableEnded} finished=${res.writableFinished} sent=${res.headersSent}`,
    );
  });
  expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
  await done.promise;
  expect(events).toEqual([
    "before ended=false sent=false",
    "after ended=true finished=false sent=true",
    "finish ended=true finished=true",
    "res close closed=true destroyed=false",
    "req close destroyed=true complete=true",
  ]);
});

test("write() reports backpressure and 'drain' follows the client", async () => {
  const chunk = Buffer.alloc(64 * 1024, 1);
  const total = 1024;
  const stats = { writes: 0, refused: 0, drains: 0, maxQueued: 0 };
  const port = await start((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    const pump = () => {
      while (stats.writes < total) {
        stats.writes++;
        const ok = res.write(chunk);
        stats.maxQueued = Math.max(stats.maxQueued, res.writableLength);
        if (!ok) {
          stats.refused++;
          expect(res.writableNeedDrain).toBe(true);
          res.once("drain", () => {
            stats.drains++;
            pump();
          });
          return;
        }
      }
      res.end();
    };
    pump();
  });
  // A client that reads nothing for a while: the server must not run ahead
  const socket = connect(port, "127.0.0.1");
  socket.pause();
  await new Promise<void>((resolve) => socket.on("connect", resolve));
  socket.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  await Bun.sleep(200);
  // The kernel buffers of the loopback take some; the rest waits in the app
  expect(stats.writes).toBeLessThan(total / 4);
  expect(stats.refused).toBeGreaterThan(0);
  expect(stats.maxQueued).toBeLessThanOrEqual(2 * chunk.byteLength);
  let received = 0;
  socket.on("data", (data) => (received += data.length));
  const ended = new Promise<void>((resolve) => socket.on("end", resolve));
  socket.resume();
  await ended;
  expect(stats.writes).toBe(total);
  expect(stats.drains).toBeGreaterThan(0);
  expect(received).toBeGreaterThanOrEqual(total * chunk.byteLength);
});

test("'finish' on a chunked body waits until Bun has taken every chunk", async () => {
  const chunk = Buffer.alloc(64 * 1024, 2);
  const total = 128;
  const events: string[] = [];
  const ended = defer();
  const port = await start((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    // 8 MiB written whole, without waiting for 'drain'
    for (let i = 0; i < total; i++) res.write(chunk);
    res.on("finish", () => events.push(`finish queued=${res.writableLength}`));
    res.on("close", () => events.push("close"));
    res.end(() => ended.resolve());
    events.push(`ended finished=${res.writableFinished}`);
  });
  const socket = connect(port, "127.0.0.1");
  socket.pause();
  await new Promise<void>((resolve) => socket.on("connect", resolve));
  socket.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  await Bun.sleep(300);
  // The client reads nothing: the body is still queued, so not finished
  expect(events).toEqual(["ended finished=false"]);
  let received = 0;
  socket.on("data", (data) => (received += data.length));
  const closed = new Promise<void>((resolve) => socket.on("end", resolve));
  socket.resume();
  await closed;
  await ended.promise;
  expect(received).toBeGreaterThanOrEqual(total * chunk.byteLength);
  expect(events).toEqual(["ended finished=false", "finish queued=0", "close"]);
});

test("Readable.pipe(res) delivers the source whole and ends the response", async () => {
  const parts = Array.from({ length: 50 }, (_, i) =>
    `${i}`.padStart(1000, "x"),
  );
  const port = await start((_req, res) => {
    res.setHeader("Content-Type", "text/plain");
    Readable.from(parts).pipe(res);
  });
  const response = await fetch(`http://127.0.0.1:${port}/`);
  expect(response.headers.get("transfer-encoding")).toBe("chunked");
  expect(await response.text()).toBe(parts.join(""));
});

test("a streamed body written whole in one turn keeps its Content-Length under 16 KiB; from 16 KiB, or split over turns, it is chunked", async () => {
  const body = Buffer.alloc(10_000, 2);
  const port = await start((req, res) => {
    if (req.url?.startsWith("/size/")) {
      const whole = Buffer.alloc(Number(req.url.slice(6)), 2);
      res.writeHead(200, { "Content-Length": whole.byteLength });
      res.write(whole);
      setTimeout(() => res.end(), 10);
      return;
    }
    res.writeHead(200, { "Content-Length": body.byteLength });
    if (req.url === "/one-turn") {
      res.write(body);
      setTimeout(() => res.end(), 10);
    } else {
      res.write(body.subarray(0, 5000));
      setTimeout(() => res.end(body.subarray(5000)), 10);
    }
  });
  const whole = await fetch(`http://127.0.0.1:${port}/one-turn`);
  expect(whole.headers.get("content-length")).toBe("10000");
  expect((await whole.arrayBuffer()).byteLength).toBe(10_000);
  // Bun frames a stream with its length only when the whole queue is under
  // its high-water mark, which a streamed body keeps at Node's 16 KiB
  const under = await fetch(`http://127.0.0.1:${port}/size/16383`);
  expect(under.headers.get("content-length")).toBe("16383");
  expect((await under.arrayBuffer()).byteLength).toBe(16_383);
  const full = await fetch(`http://127.0.0.1:${port}/size/16384`);
  expect(full.headers.get("content-length")).toBeNull();
  expect(full.headers.get("transfer-encoding")).toBe("chunked");
  expect((await full.arrayBuffer()).byteLength).toBe(16 * 1024);
  const split = await fetch(`http://127.0.0.1:${port}/split`);
  expect(split.headers.get("transfer-encoding")).toBe("chunked");
  expect((await split.arrayBuffer()).byteLength).toBe(10_000);
});

test("a reply ended with a body and no Content-Type goes out with the body's byte length and no type, whatever its size and encoding", async () => {
  // Bodies on both sides of what Bun frames by length without help, two-byte
  // characters, whose length is in bytes, and a latin1 string, one byte each
  const replies: Record<string, [string, BufferEncoding | undefined]> = {
    "/one": ["a", undefined],
    "/256": ["x".repeat(256), undefined],
    "/utf8": ["é".repeat(300_000), undefined],
    "/latin1": ["é".repeat(1000), "latin1"],
  };
  const port = await start((req, res) => {
    const [text, encoding] = replies[req.url!];
    if (encoding === undefined) res.end(text);
    else res.end(text, encoding);
  });
  for (const [path, [text, encoding]] of Object.entries(replies)) {
    const bytes = Buffer.from(text, encoding);
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    expect(response.headers.get("content-length")).toBe(
      String(bytes.byteLength),
    );
    expect(response.headers.get("transfer-encoding")).toBeNull();
    expect(response.headers.get("content-type")).toBeNull();
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  }
});

test("a reply ended with a body, no Content-Type and a declared Content-Length keeps that length", async () => {
  const body = Buffer.alloc(16 * 1024 * 1024, 7);
  const port = await start((_req, res) => {
    res.setHeader("Content-Length", body.byteLength);
    res.end(body);
  });
  const response = await fetch(`http://127.0.0.1:${port}/`);
  expect(response.headers.get("content-length")).toBe(String(16 * 1024 * 1024));
  expect(response.headers.get("transfer-encoding")).toBeNull();
  expect(response.headers.get("content-type")).toBeNull();
  expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
});

test("a client leaving mid-stream closes the response without 'finish' and destroys the request", async () => {
  const events: string[] = [];
  const closed = defer();
  const port = await start((req, res) => {
    res.on("finish", () => events.push("finish"));
    res.on("close", () => {
      events.push(
        `res close destroyed=${res.destroyed} errored=${res.errored instanceof Error}`,
      );
    });
    req.on("aborted", () => events.push("req aborted"));
    req.on("close", () => {
      events.push(`req close destroyed=${req.destroyed}`);
      closed.resolve();
    });
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("first");
    const timer = setInterval(() => {
      if (!res.write("more")) clearInterval(timer);
    }, 5);
    res.on("close", () => clearInterval(timer));
  });
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.on("connect", resolve));
  socket.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
  await new Promise<void>((resolve) => socket.once("data", () => resolve()));
  socket.destroy();
  await closed.promise;
  // As Node: a request whose stream was never read is aborted, body or not
  expect(events).toEqual([
    "req aborted",
    "res close destroyed=true errored=false",
    "req close destroyed=true",
  ]);
});

test("a client leaving before the reply aborts an unread body and closes the response", async () => {
  const events: string[] = [];
  const closed = defer();
  const port = await start((req, res) => {
    req.on("aborted", () => events.push(`aborted complete=${req.complete}`));
    req.on("close", () => events.push("req close"));
    res.on("finish", () => events.push("finish"));
    res.on("close", () => {
      events.push(`res close writableEnded=${res.writableEnded}`);
      closed.resolve();
    });
  });
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.on("connect", resolve));
  socket.write("POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhel");
  await Bun.sleep(50);
  socket.destroy();
  await closed.promise;
  await Bun.sleep(10);
  expect(events).toEqual([
    "aborted complete=false",
    "res close writableEnded=false",
    "req close",
  ]);
});

test("req.socket stands in for the connection and destroying it drops the client", async () => {
  const seen: Record<string, unknown> = {};
  const port = await start((req, res) => {
    const socket = req.socket as any;
    Object.assign(seen, {
      remoteAddress: socket.remoteAddress,
      remotePort: typeof socket.remotePort,
      localPort: socket.localPort,
      encrypted: socket.encrypted,
      server: socket.server === server,
      sameAsRes: res.socket === socket && req.connection === socket,
      httpMessage: socket._httpMessage === res,
      writable: socket.writable,
    });
    socket.setKeepAlive(true).setNoDelay(true).setTimeout(0);
    if (req.url === "/drop") {
      socket.destroy();
      socket.on("close", () => (seen.socketClosed = socket.destroyed));
    } else {
      res.end("ok");
    }
  });
  expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
  expect(seen).toEqual({
    remoteAddress: "127.0.0.1",
    remotePort: "number",
    localPort: port,
    encrypted: false,
    server: true,
    sameAsRes: true,
    httpMessage: true,
    writable: true,
  });
  await expect(fetch(`http://127.0.0.1:${port}/drop`)).rejects.toThrow();
  expect(seen.socketClosed).toBe(true);
});

test("the header API follows ServerResponse", async () => {
  const errors: string[] = [];
  const port = await start((_req, res) => {
    res.setHeader("X-One", "1");
    res.setHeader("x-two", ["a", "b"]);
    res.appendHeader("X-One", "2");
    res.appendHeader("X-Three", "3");
    res.removeHeader("X-TWO");
    expect(res.hasHeader("x-one")).toBe(true);
    expect(res.hasHeader("x-two")).toBe(false);
    expect(res.getHeader("X-ONE")).toEqual(["1", "2"]);
    expect(res.getHeaderNames()).toEqual(["x-one", "x-three"]);
    expect(res.getHeaders()).toEqual({ "x-one": ["1", "2"], "x-three": "3" });
    for (const [name, value] of [
      ["Bad Name", "1"],
      ["X-Bad", "a\nb"],
      ["X-Bad", undefined],
    ] as const) {
      try {
        res.setHeader(name, value as string);
      } catch (error) {
        errors.push((error as NodeJS.ErrnoException).code!);
      }
    }
    for (const status of [99, 150, 600]) {
      try {
        res.writeHead(status);
      } catch (error) {
        errors.push((error as NodeJS.ErrnoException).code!);
      }
    }
    expect(res.headersSent).toBe(false);
    res.writeHead(201, "Made", ["X-Four", "4", "X-Four", "5"]);
    expect(res.headersSent).toBe(true);
    expect(res.statusMessage).toBe("Made");
    try {
      res.setHeader("X-Late", "1");
    } catch (error) {
      errors.push((error as NodeJS.ErrnoException).code!);
    }
    res.end();
  });
  const response = await fetch(`http://127.0.0.1:${port}/`);
  expect(response.status).toBe(201);
  expect(response.headers.get("x-one")).toBe("1, 2");
  expect(response.headers.get("x-three")).toBe("3");
  expect(response.headers.get("x-four")).toBe("4, 5");
  expect(response.headers.has("x-two")).toBe(false);
  expect(errors).toEqual([
    "ERR_INVALID_HTTP_TOKEN",
    "ERR_INVALID_CHAR",
    "ERR_HTTP_INVALID_HEADER_VALUE",
    "ERR_HTTP_INVALID_STATUS_CODE",
    "ERR_HTTP_INVALID_STATUS_CODE",
    "ERR_HTTP_INVALID_STATUS_CODE",
    "ERR_HTTP_HEADERS_SENT",
  ]);
});

test("writing after end fails through the callback and returns false", async () => {
  const outcome = defer<string>();
  const port = await start((_req, res) => {
    res.end("done");
    const ok = res.write("late", (error) => {
      outcome.resolve(`${ok} ${(error as NodeJS.ErrnoException)?.code}`);
    });
  });
  expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("done");
  expect(await outcome.promise).toBe("false ERR_STREAM_WRITE_AFTER_END");
});

test("req.signal aborts once the request is closed", async () => {
  const aborted = defer<boolean>();
  const port = await start((req, res) => {
    const { signal } = req as any;
    expect(signal.aborted).toBe(false);
    signal.addEventListener("abort", () => aborted.resolve(req.destroyed));
    res.end("ok");
  });
  await fetch(`http://127.0.0.1:${port}/`);
  expect(await aborted.promise).toBe(true);
});

test("close() frees the port at once when idle and waits for in-flight responses otherwise", async () => {
  const port = await start((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  // Node releases the port synchronously: the next listen() on it succeeds
  server = new BunHttpServer((req, res) => {
    if (req.url === "/slow") setTimeout(() => res.end("slow"), 100);
    else res.end("ok");
  });
  await new Promise<void>((resolve) =>
    server!.listen(port, "127.0.0.1", resolve),
  );
  const slow = new Promise<string>((resolve, reject) => {
    httpRequest(
      { host: "127.0.0.1", port, path: "/slow", agent: false },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve(text));
      },
    )
      .on("error", reject)
      .end();
  });
  await Bun.sleep(20);
  const started = Date.now();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  expect(await slow).toBe("slow");
  server = undefined;
});

test("req.complete reflects the body without touching it, and the native read ends the stream", async () => {
  const seen: unknown[] = [];
  const port = await start(async (req, res) => {
    const read = (req as any)[READ_NATIVE_BODY];
    seen.push(req.complete, req.readableEnded);
    if (req.method === "POST") {
      const body = await new Promise<Buffer>((resolve, reject) => {
        seen.push(read.call(req, false, resolve, reject));
      });
      seen.push(req.complete, req.readableEnded, body.toString());
    }
    // Nothing left to read natively: the body is done
    seen.push(read.call(req, false, noop, noop));
    res.end("ok");
  });
  await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "hello" });
  await fetch(`http://127.0.0.1:${port}/`);
  expect(seen).toEqual([
    false,
    false,
    true,
    true,
    true,
    "hello",
    false,
    true,
    false,
    false,
  ]);
});

test("a 'data' listener attached before the parser still receives the body", async () => {
  const outcome = defer<string>();
  const parser = json();
  const port = await start((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    parser(req as any, res as any, (error?: any) => {
      outcome.resolve(
        `${error ?? "ok"} ${Buffer.concat(chunks)} ${JSON.stringify((req as any).body)}`,
      );
      res.end("ok");
    });
  });
  await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"a":1}',
  });
  expect(await outcome.promise).toBe('ok {"a":1} {"a":1}');
});

test("the parser reads the headers a middleware replaced on the request", async () => {
  const outcome = defer<string>();
  const parser = json();
  const port = await start((req, res) => {
    req.headers = { ...req.headers, "content-type": "application/json" };
    parser(req as any, res as any, (error?: any) => {
      outcome.resolve(`${error ?? "ok"} ${JSON.stringify((req as any).body)}`);
      res.end("ok");
    });
  });
  await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: '{"a":1}',
  });
  expect(await outcome.promise).toBe('ok {"a":1}');
});

test("the JSON parser's native read reports a client that leaves mid-body as aborted", async () => {
  const outcome = defer<string>();
  const parser = json();
  const port = await start((req, res) => {
    parser(req as any, res as any, (error?: any) => {
      outcome.resolve(
        `${error?.statusCode} ${error?.type} ${error?.code} destroyed=${req.destroyed} expected=${error?.expected} received=${error?.received}`,
      );
    });
  });
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.on("connect", resolve));
  socket.write(
    'POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{"a":',
  );
  await Bun.sleep(50);
  socket.destroy();
  // Bun does not tell how much of the body had arrived: no received count
  expect(await outcome.promise).toBe(
    "400 request.aborted ECONNABORTED destroyed=true expected=10 received=undefined",
  );
});

test("a client that left before anything watched the request is still reported", async () => {
  const events: string[] = [];
  const done = defer();
  const port = await start((req, res) => {
    // Nothing watches the connection until the handler listens, by which
    // time the client is gone
    setTimeout(() => {
      req.on("aborted", () => events.push("req aborted"));
      res.on("close", () =>
        events.push(`res close destroyed=${res.destroyed}`),
      );
      req.on("close", () => {
        events.push(`req close destroyed=${req.destroyed}`);
        done.resolve();
      });
    }, 50);
  });
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.on("connect", resolve));
  socket.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
  await Bun.sleep(10);
  socket.destroy();
  expect(
    await Promise.race([
      done.promise.then(() => "closed"),
      Bun.sleep(1000).then(() => "never closed"),
    ]),
  ).toBe("closed");
  expect(events).toEqual([
    "req aborted",
    "res close destroyed=true",
    "req close destroyed=true",
  ]);
});

test("req.destroy() on a request without a body aborts it and drops the client", async () => {
  const events: string[] = [];
  const port = await start((req, res) => {
    req.on("aborted", () => events.push("req aborted"));
    req.on("close", () => events.push("req close"));
    res.on("close", () =>
      events.push(`res close finished=${res.writableFinished}`),
    );
    req.destroy();
  });
  await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  await Bun.sleep(10);
  expect(events[0]).toBe("req aborted");
  expect(events.slice(1).sort()).toEqual([
    "req close",
    "res close finished=false",
  ]);
});

test("writeHead() takes headers in place of a reason and its array form replaces earlier values", async () => {
  const port = await start((req, res) => {
    res.setHeader("X-Kept", "1");
    res.setHeader("X-Dup", "old");
    if (req.url === "/object") {
      res.writeHead(200, undefined, { "X-Obj": "2" });
    } else if (req.url === "/null-reason") {
      res.writeHead(200, null as any, ["X-Dup", "a", "X-Dup", "b"]);
    } else {
      res.writeHead(200, ["X-Dup", "a", "X-Dup", "b", "X-Arr", "3"]);
    }
    res.end();
  });
  const object = await fetch(`http://127.0.0.1:${port}/object`);
  expect([object.headers.get("x-kept"), object.headers.get("x-obj")]).toEqual([
    "1",
    "2",
  ]);
  const nullReason = await fetch(`http://127.0.0.1:${port}/null-reason`);
  expect(nullReason.headers.get("x-dup")).toBe("a, b");
  const array = await fetch(`http://127.0.0.1:${port}/array`);
  expect([
    array.headers.get("x-kept"),
    array.headers.get("x-dup"),
    array.headers.get("x-arr"),
  ]).toEqual(["1", "a, b", "3"]);
});

test("close() works again after listen() was called again", async () => {
  let closes = 0;
  const port = await start((_req, res) => res.end("ok"));
  server!.on("close", () => closes++);
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server!.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  expect(closes).toBe(2);
  // The port is free again
  const refused = new Promise<string>((resolve) => {
    connect(port, "127.0.0.1")
      .on("error", (error: NodeJS.ErrnoException) => resolve(error.code!))
      .on("connect", () => resolve("connected"));
  });
  expect(await refused).toBe("ECONNREFUSED");
  server = undefined;
});

test("close() turns away new connections while a busy one finishes", async () => {
  const port = await start((req, res) => {
    if (req.url === "/slow") setTimeout(() => res.end("slow"), 150);
    else res.end("ok");
  });
  const busy = connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => busy.on("connect", resolve));
  let busyOut = "";
  busy.on("data", (data) => (busyOut += data));
  busy.write("GET /slow HTTP/1.1\r\nHost: x\r\n\r\n");
  await Bun.sleep(20);
  const closed = new Promise<void>((resolve) => server!.close(() => resolve()));
  // A connection opened after close(): Node refuses it; here the port is
  // still bound until the busy connection is done, so it gets a 503 that
  // closes it
  const late = connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => late.on("connect", resolve));
  let lateOut = "";
  late.on("data", (data) => (lateOut += data));
  const lateClosed = new Promise<void>((resolve) => late.on("close", resolve));
  late.write("GET /new HTTP/1.1\r\nHost: x\r\n\r\n");
  await lateClosed;
  expect(lateOut).toMatch(/^HTTP\/1\.1 503 /);
  expect(lateOut).toMatch(/connection: close/i);
  await closed;
  expect(busyOut).toMatch(/slow$/);
  server = undefined;
});

// A client keeping one connection to the server, as a raw socket
async function rawClient(port: number) {
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.on("connect", resolve));
  socket.on("error", noop);
  let out = "";
  socket.on("data", (data) => (out += data));
  return {
    get out() {
      return out;
    },
    send(path: string) {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`);
    },
    async received(text: string) {
      while (!out.endsWith(text)) await Bun.sleep(1);
    },
    destroy() {
      socket.destroy();
    },
  };
}

test("close() answers a request a client sends on its busy connection once it has read the reply", async () => {
  const port = await start((req, res) => {
    if (req.url === "/slow") setTimeout(() => res.end("slow"), 300);
    else res.end("next");
  });
  const client = await rawClient(port);
  client.send("/slow");
  await Bun.sleep(20);
  const closed = new Promise<void>((resolve) => server!.close(() => resolve()));
  await client.received("slow");
  // As a keep-alive client sends the request it queued for this connection
  await Bun.sleep(20);
  client.send("/next");
  await closed;
  expect(client.out).toMatch(/slow.*HTTP\/1\.1 200 .*next$/s);
  client.destroy();
  server = undefined;
});

test("close() keeps waiting after each reply on a busy connection", async () => {
  const port = await start((req, res) => {
    if (req.url === "/slow") setTimeout(() => res.end("slow"), 300);
    else res.end(req.url!.slice(1));
  });
  const client = await rawClient(port);
  client.send("/slow");
  await Bun.sleep(20);
  const closed = new Promise<void>((resolve) => server!.close(() => resolve()));
  await client.received("slow");
  await Bun.sleep(150);
  client.send("/second");
  await client.received("second");
  // Later than the wait after the first reply, within the one after this one
  await Bun.sleep(150);
  client.send("/third");
  await closed;
  expect(client.out).toMatch(
    /slow.*HTTP\/1\.1 200 .*second.*HTTP\/1\.1 200 .*third$/s,
  );
  client.destroy();
  server = undefined;
});

test("close() closes a busy connection once nothing has been in flight for 250 ms", async () => {
  const port = await start((req, res) => {
    if (req.url === "/slow") setTimeout(() => res.end("slow"), 50);
    else res.end("late");
  });
  const client = await rawClient(port);
  client.send("/slow");
  await Bun.sleep(20);
  let closedAt = 0;
  const closed = new Promise<void>((resolve) =>
    server!.close(() => {
      closedAt = performance.now();
      resolve();
    }),
  );
  await client.received("slow");
  const repliedAt = performance.now();
  await Bun.sleep(600);
  client.send("/late");
  await closed;
  expect(closedAt - repliedAt).toBeGreaterThanOrEqual(200);
  expect(closedAt - repliedAt).toBeLessThan(600);
  await Bun.sleep(50);
  expect(client.out).toMatch(/slow$/);
  client.destroy();
  server = undefined;
});

test("close() waits for a server.fetch() request made while it waits for further requests", async () => {
  const events: string[] = [];
  const port = await start((req, res) => {
    if (req.url === "/slow") return void setTimeout(() => res.end("slow"), 50);
    // Later than close()'s wait after the first reply would end
    setTimeout(() => {
      events.push("replied");
      res.end("late");
    }, 400);
  });
  const client = await rawClient(port);
  client.send("/slow");
  await Bun.sleep(20);
  const closed = new Promise<void>((resolve) =>
    server!.close(() => {
      events.push("closed");
      resolve();
    }),
  );
  await client.received("slow");
  // Bun counts no pending request for it: only the transport knows it is busy
  const response = server!.nativeServer!.fetch(
    new Request("http://127.0.0.1/fetch"),
  );
  expect(await (await response).text()).toBe("late");
  await closed;
  expect(events).toEqual(["replied", "closed"]);
  client.destroy();
  server = undefined;
});

test("close() answers a request sent on a busy connection once the reply Bun was still sending is out", async () => {
  // The response is done once Bun has taken the body, while Bun is still
  // sending it to a client that reads nothing yet
  const body = Buffer.alloc(16 * 1024 * 1024, 4);
  const sent = defer();
  const port = await start((req, res) => {
    if (req.url !== "/big") return void res.end("next");
    res.on("close", () => sent.resolve());
    res.setHeader("Content-Length", body.length);
    setTimeout(() => res.end(body), 50);
  });
  const socket = connect(port, "127.0.0.1");
  socket.pause();
  await new Promise<void>((resolve) => socket.on("connect", resolve));
  socket.on("error", noop);
  let head = "";
  let tail = "";
  let received = 0;
  socket.on("data", (data: Buffer) => {
    if (head.length < 1024) head += data.subarray(0, 1024).toString("latin1");
    tail = (tail + data.subarray(-256).toString("latin1")).slice(-256);
    received += data.length;
  });
  socket.write("GET /big HTTP/1.1\r\nHost: x\r\n\r\n");
  await Bun.sleep(20);
  const closed = new Promise<void>((resolve) => server!.close(() => resolve()));
  await sent.promise;
  // Longer than close()'s wait after the response
  await Bun.sleep(400);
  socket.resume();
  const headBytes = () => head.indexOf("\r\n\r\n") + 4;
  while (headBytes() < 4 || received < headBytes() + body.length) {
    await Bun.sleep(1);
  }
  await Bun.sleep(20);
  socket.write("GET /next HTTP/1.1\r\nHost: x\r\n\r\n");
  await closed;
  expect(tail).toMatch(/HTTP\/1\.1 200 .*next$/s);
  socket.destroy();
  server = undefined;
});

test("close() with requests in flight emits 'close' once, and once more when closed again after listen()", async () => {
  let closes = 0;
  const port = await start((req, res) => {
    setTimeout(() => res.end(req.url!.slice(1)), 30);
  });
  server!.on("close", () => closes++);
  for (const round of [1, 2]) {
    const client = await rawClient(port);
    client.send("/first");
    await Bun.sleep(10);
    const closed = new Promise<void>((resolve) =>
      server!.close(() => resolve()),
    );
    // Each reply starts close()'s wait over
    for (const path of ["first", "second", "third"]) {
      await client.received(path);
      if (path !== "third")
        client.send(`/${path === "first" ? "second" : "third"}`);
    }
    await closed;
    await Bun.sleep(300);
    expect(closes).toBe(round);
    client.destroy();
    if (round === 1) {
      await new Promise<void>((resolve) =>
        server!.listen(port, "127.0.0.1", resolve),
      );
      // With no close() in progress: nothing to end
      server!.closeAllConnections();
      await Bun.sleep(50);
      expect(closes).toBe(1);
    }
  }
  server = undefined;
});

test("close() called while Bun is still sending a reply ends once the reply is out", async () => {
  const body = Buffer.alloc(16 * 1024 * 1024, 4);
  const sent = defer();
  const port = await start((_req, res) => {
    res.on("close", () => sent.resolve());
    res.setHeader("Content-Type", "application/octet-stream");
    res.end(body);
  });
  const socket = connect(port, "127.0.0.1");
  socket.pause();
  await new Promise<void>((resolve) => socket.on("connect", resolve));
  socket.on("error", noop);
  let received = 0;
  socket.on("data", (data) => (received += data.length));
  const ended = new Promise<void>((resolve) => socket.on("end", resolve));
  socket.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
  // The response is done; Bun still has the body to send
  await sent.promise;
  const closed = new Promise<void>((resolve) => server!.close(() => resolve()));
  await Bun.sleep(100);
  socket.resume();
  await closed;
  await ended;
  expect(received).toBeGreaterThan(body.length);
  socket.destroy();
  server = undefined;
});

// No connection is left to send a request on, so close() ends well within
// the wait it would otherwise make
async function closesAtOnce(closed: Promise<void>) {
  server!.closeAllConnections();
  const first = await Promise.race([
    closed.then(() => "closed"),
    Bun.sleep(125).then(() => "still waiting"),
  ]);
  expect(first).toBe("closed");
}

test("closeAllConnections() lets a close() waiting on a reply finish without waiting for further requests", async () => {
  const port = await start(noop);
  let closes = 0;
  server!.on("close", () => closes++);
  const client = await rawClient(port);
  client.send("/never");
  await Bun.sleep(20);
  await closesAtOnce(
    new Promise<void>((resolve) => server!.close(() => resolve())),
  );
  await Bun.sleep(100);
  expect(closes).toBe(1);
  client.destroy();
  server = undefined;
});

test("closeAllConnections() during close() with a server.fetch() request in flight emits 'close' once", async () => {
  await start(noop);
  let closes = 0;
  server!.on("close", () => closes++);
  // Bun counts no pending request for it: only the transport knows it is busy
  const response = server!.nativeServer!.fetch(
    new Request("http://127.0.0.1/"),
  );
  response.catch(noop);
  await Bun.sleep(5);
  await closesAtOnce(
    new Promise<void>((resolve) => server!.close(() => resolve())),
  );
  await Bun.sleep(100);
  expect(closes).toBe(1);
  server = undefined;
});

test("closeAllConnections() lets a close() waiting for further requests finish at once", async () => {
  const port = await start((_req, res) => {
    setTimeout(() => res.end("slow"), 50);
  });
  const client = await rawClient(port);
  client.send("/slow");
  await Bun.sleep(20);
  const closed = new Promise<void>((resolve) => server!.close(() => resolve()));
  await client.received("slow");
  // close() now waits for a request on that connection
  await Bun.sleep(20);
  await closesAtOnce(closed);
  client.destroy();
  server = undefined;
});

test("the HTTPS facade carries the server timeouts", () => {
  const https = new BunHttpsServer(noop, {}) as any;
  expect(typeof https.setTimeout).toBe("function");
  expect([
    https.timeout,
    https.keepAliveTimeout,
    https.keepAliveTimeoutBuffer,
    https.headersTimeout,
    https.requestTimeout,
    https.maxHeadersCount,
    https.maxRequestsPerSocket,
  ]).toEqual([0, 5000, 1000, 60000, 300000, null, null]);
  https.keepAliveTimeout = 10;
  https.keepAliveTimeoutBuffer = 20;
  expect(https.setTimeout(7, noop)).toBe(https);
  expect([
    https.timeout,
    https.keepAliveTimeout,
    https.keepAliveTimeoutBuffer,
  ]).toEqual([7, 10, 20]);
});

test("a write() callback waits until Bun has taken the chunk", async () => {
  const chunk = Buffer.alloc(64 * 1024, 3);
  const total = 256;
  let writes = 0;
  const port = await start((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    // A producer paced by the callbacks alone, never looking at 'drain'
    const pump = () => {
      if (writes === total) {
        res.end();
        return;
      }
      writes++;
      res.write(chunk, pump);
    };
    pump();
  });
  const socket = connect(port, "127.0.0.1");
  socket.pause();
  await new Promise<void>((resolve) => socket.on("connect", resolve));
  socket.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  await Bun.sleep(200);
  // The client reads nothing: the callbacks must not have let the producer
  // queue the whole body
  expect(writes).toBeLessThan(total / 4);
  let received = 0;
  socket.on("data", (data) => (received += data.length));
  const ended = new Promise<void>((resolve) => socket.on("end", resolve));
  socket.resume();
  await ended;
  expect(writes).toBe(total);
  expect(received).toBeGreaterThanOrEqual(total * chunk.byteLength);
});

test("a 'data' listener attached after the parser started still receives the body", async () => {
  const outcome = defer<string>();
  const parser = json();
  const port = await start((req, res) => {
    const chunks: Buffer[] = [];
    let parsed = "";
    parser(req as any, res as any, (error?: any) => {
      parsed = `${error ?? "ok"} ${JSON.stringify((req as any).body)}`;
    });
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      outcome.resolve(`${parsed} ${Buffer.concat(chunks)}`);
      res.end("ok");
    });
  });
  await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"a":1}',
  });
  expect(await outcome.promise).toBe('ok {"a":1} {"a":1}');
});

test("a consumed request is destroyed after its body, as under Node; an unread one ends with the response", async () => {
  const events: string[] = [];
  let done = defer();
  const port = await start((req, res) => {
    req.on("close", () => events.push(`req close destroyed=${req.destroyed}`));
    res.on("finish", () => events.push("res finish"));
    res.on("close", () => {
      events.push("res close");
      if (req.url === "/unread") done.resolve();
    });
    if (req.url === "/consumed") {
      let n = 0;
      req.on("data", (data) => (n += data.length));
      req.on("end", () => {
        events.push(`req end n=${n} destroyed=${req.destroyed}`);
        setTimeout(() => {
          events.push(`before end destroyed=${req.destroyed}`);
          res.end("ok");
          done.resolve();
        }, 30);
      });
      return;
    }
    finished(req, (error) =>
      events.push(`finished(req) ${error ? (error as any).code : "ok"}`),
    );
    req.on("end", () => events.push("req end unread"));
    res.end("ok");
  });
  const post = (path: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: "hello" });
  await (await post("/consumed")).text();
  await done.promise;
  await Bun.sleep(10);
  expect(events).toEqual([
    "req end n=5 destroyed=false",
    "req close destroyed=true",
    "before end destroyed=true",
    "res finish",
    "res close",
  ]);
  events.length = 0;
  done = defer();
  await (await post("/unread")).text();
  await done.promise;
  await Bun.sleep(10);
  expect(events).toEqual([
    "res finish",
    "res close",
    "req end unread",
    "req close destroyed=true",
    "finished(req) ok",
  ]);
});

test("a response sent while the body is still being read aborts the request", async () => {
  const events: string[] = [];
  const done = defer();
  const port = await start((req, res) => {
    req.on("data", () => events.push("data"));
    req.on("end", () => events.push("end"));
    req.on("aborted", () => events.push(`aborted complete=${req.complete}`));
    req.on("close", () => {
      events.push(`close destroyed=${req.destroyed}`);
      done.resolve();
    });
    res.end("early");
  });
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.on("connect", resolve));
  let out = "";
  socket.on("data", (data) => (out += data));
  socket.write("POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\nhello");
  await done.promise;
  await Bun.sleep(20);
  // Bun drops the rest of a body once the response is out: the request
  // ends as aborted, never as complete
  expect(events).toEqual(["aborted complete=false", "close destroyed=true"]);
  expect(out).toMatch(/early$/);
  socket.destroy();
});

test("the parser reads the method Bun served, not one a middleware replaced", async () => {
  const outcome = defer<string>();
  const parser = json();
  const port = await start((req, res) => {
    req.method = "GET";
    parser(req as any, res as any, (error?: any) => {
      outcome.resolve(`${error ?? "ok"} ${JSON.stringify((req as any).body)}`);
      res.end("ok");
    });
  });
  await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"a":1}',
  });
  expect(await outcome.promise).toBe('ok {"a":1}');
});

test("a request and a response nothing listened to yet report no listeners", async () => {
  const names = defer<unknown[]>();
  const port = await start((req, res) => {
    const before = [req.eventNames(), res.eventNames()];
    req.on("data", noop);
    res.on("finish", noop);
    names.resolve([...before, req.eventNames(), res.eventNames()]);
    res.end("ok");
  });
  await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
  expect(await names.promise).toEqual([[], [], ["data"], ["finish"]]);
});

// The fetch handler as Bun calls it for a request read from a socket: with
// the server as its second argument
function socketFetch(target: BunHttpServer, request: Request) {
  return (target as any).serveOptions.fetch(request, target.nativeServer);
}

test("an asynchronous reply that awaited nothing pending is handed to Bun as a Response", async () => {
  const port = await start(async (_req, res) => {
    await null;
    res.end("ok");
  });
  const handed = socketFetch(server!, new Request(`http://127.0.0.1:${port}/`));
  expect(handed).toBeInstanceOf(Response);
  expect(await (handed as Response).text()).toBe("ok");
});

test("server.fetch() runs none of its caller's microtasks before it returns", async () => {
  const port = await start(async (_req, res) => {
    await null;
    res.end("ok");
  });
  let ran = false;
  queueMicrotask(() => {
    ran = true;
  });
  const handed = server!.nativeServer!.fetch(
    new Request(`http://127.0.0.1:${port}/`),
  );
  expect(ran).toBe(false);
  expect(await (await handed).text()).toBe("ok");
  expect(ran).toBe(true);
});

test("a request Bun dispatches while another's microtasks run is answered through a promise", async () => {
  let inner: unknown;
  const port = await start(async (req, res) => {
    if (req.url === "/outer") {
      // As when the reply resolved here lets Bun read the next request of a
      // connection
      queueMicrotask(() => {
        inner = socketFetch(
          server!,
          new Request(`http://127.0.0.1:${port}/inner`),
        );
      });
    }
    await null;
    res.end(req.url);
  });
  const outer = socketFetch(
    server!,
    new Request(`http://127.0.0.1:${port}/outer`),
  );
  expect(outer).toBeInstanceOf(Response);
  expect(inner).toBeInstanceOf(Promise);
  expect(await (await (inner as Promise<Response>)).text()).toBe("/inner");
});

test("a one-body reply is sent with the headers it set", async () => {
  const port = await start((req, res) => {
    if (req.url!.startsWith("/typed")) {
      // A type alone, as most replies have
      res.setHeader("Content-Type", "application/x-custom");
      res.end(req.url === "/typed" ? "typed" : "typed again");
      return;
    }
    res.setHeader("X-Custom", "1");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Length", 5);
    res.end("a,b,c");
  });
  for (const [path, body] of [
    ["/typed", "typed"],
    ["/typed-again", "typed again"],
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    expect(response.headers.get("content-type")).toBe("application/x-custom");
    expect(response.headers.get("content-length")).toBe(String(body.length));
    expect(await response.text()).toBe(body);
  }
  const full = await fetch(`http://127.0.0.1:${port}/full`);
  expect(full.headers.get("x-custom")).toBe("1");
  expect(full.headers.get("content-type")).toBe("text/csv");
  expect(full.headers.get("content-length")).toBe("5");
  expect(await full.text()).toBe("a,b,c");
});

test("a reason phrase the application set reaches the native Response", async () => {
  // On the wire Bun sends the standard phrase; the Response itself, which
  // server.fetch() returns, keeps the one that was set
  await start((req, res) => {
    if (req.url === "/custom") res.statusMessage = "Made Up";
    res.end("ok");
  });
  const response = await server!.nativeServer!.fetch(
    new Request("http://127.0.0.1/custom"),
  );
  expect(response.statusText).toBe("Made Up");
});

test("a request nothing read or watched has ended and closed once its response is done", async () => {
  const requests: IncomingMessage[] = [];
  const port = await start((req, res) => {
    requests.push(req);
    res.end("ok");
  });
  await (await fetch(`http://127.0.0.1:${port}/`)).text();
  await (
    await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "unread" })
  ).text();
  await Bun.sleep(10);
  // As under Node: neither aborted, the body counted as received, the stream
  // ended and destroyed
  expect(
    requests.map((req) => [
      req.aborted,
      req.complete,
      req.readableEnded,
      req.destroyed,
      req.closed,
    ]),
  ).toEqual([
    [false, true, true, true, true],
    [false, true, true, true, true],
  ]);
});

test("a 'readable' listener attached just before the parser still receives the body", async () => {
  const outcome = defer<string>();
  const parser = json();
  const port = await start((req, res) => {
    const chunks: Buffer[] = [];
    req.on("readable", () => {
      let chunk: Buffer | null;
      while ((chunk = req.read() as Buffer | null) !== null) chunks.push(chunk);
    });
    parser(req as any, res as any, (error?: any) => {
      outcome.resolve(
        `${error ?? "ok"} ${Buffer.concat(chunks)} ${JSON.stringify((req as any).body)}`,
      );
      res.end("ok");
    });
  });
  await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"a":1}',
  });
  expect(await outcome.promise).toBe('ok {"a":1} {"a":1}');
});

test("replies of one type share a native Headers, for at most 256 types", () => {
  typeHeaders.clear();
  const first = contentTypeHeaders("text/x-first");
  expect(first.get("content-type")).toBe("text/x-first");
  for (let i = 1; i < 256; i++) contentTypeHeaders(`text/x-${i}`);
  // 256 types held: the first is still shared
  expect(contentTypeHeaders("text/x-first")).toBe(first);
  // Another one starts the cache over, so that it stays bounded
  contentTypeHeaders("text/x-256");
  expect(contentTypeHeaders("text/x-first")).not.toBe(first);
});

test("close() waits for a request made through server.fetch()", async () => {
  const events: string[] = [];
  await start((_req, res) => {
    // Later than close()'s wait for further requests would end
    setTimeout(() => {
      events.push("replied");
      res.end("late");
    }, 400);
  });
  // Bun counts no pending request for it: only the transport knows it is busy
  const response = server!.nativeServer!.fetch(
    new Request("http://127.0.0.1/"),
  );
  await Bun.sleep(5);
  const closed = new Promise<void>((resolve) =>
    server!.close(() => {
      events.push("closed");
      resolve();
    }),
  );
  expect(await (await response).text()).toBe("late");
  await closed;
  expect(events).toEqual(["replied", "closed"]);
  server = undefined;
});

test("a request a middleware paused gives its body to it and to the parser once resumed", async () => {
  const outcome = defer<string>();
  const parser = json();
  const port = await start((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.pause();
    parser(req as any, res as any, (error?: any) => {
      outcome.resolve(
        `${error ?? "ok"} ${Buffer.concat(chunks)} ${JSON.stringify((req as any).body)}`,
      );
      res.end("ok");
    });
    setTimeout(() => req.resume(), 20);
  });
  await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"a":1}',
  });
  expect(await outcome.promise).toBe('ok {"a":1} {"a":1}');
});
