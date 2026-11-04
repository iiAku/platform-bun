// Idle keep-alive connections: the server closes them once Node's
// keepAliveTimeout (plus its buffer) has passed, and never cuts a reply that
// the application is still producing. Bun's idle timer ticks every four
// seconds, so the socket tests use a keepAliveTimeout of 1 ms, whose window is
// the shortest Bun allows: a connection closes 4 to 8 s after its last reply.
import { afterAll, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import {
  BunHttpServer,
  keepAliveIdleTimeout,
} from "../../src/transport/bun-http-server";

// Longer than the idle window of the socket tests
const PAST_WINDOW = 8500;

const servers: BunHttpServer[] = [];
afterAll(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

async function serve(
  listener: (req: IncomingMessage, res: ServerResponse) => void,
  settings: { keepAliveTimeout?: number; keepAliveTimeoutBuffer?: number } = {},
) {
  const server = new BunHttpServer(listener);
  servers.push(server);
  Object.assign(server, {
    keepAliveTimeout: 1,
    keepAliveTimeoutBuffer: 0,
    ...settings,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

/** A keep-alive client connection, and when the server closes it. */
function client(port: number) {
  const socket = connect(port, "127.0.0.1");
  let received = "";
  let reply: { end: string; settle: (done: boolean) => void } | undefined;
  let closed = false;
  socket.on("data", (chunk) => {
    received += chunk;
    // The body ends with `end`, whether Bun sent its length or chunked it
    if (
      reply !== undefined &&
      (received.endsWith(reply.end) ||
        received.endsWith(`${reply.end}\r\n0\r\n\r\n`))
    ) {
      reply.settle(true);
      reply = undefined;
    }
  });
  const close = new Promise<void>((resolve) =>
    socket.on("close", () => {
      closed = true;
      reply?.settle(false);
      resolve();
    }),
  );
  return {
    /** Sends a request: whether its reply, whose body ends with `end`, arrived */
    request(path: string, end: string, method = "GET") {
      return new Promise<boolean>((settle) => {
        reply = { end, settle };
        socket.write(`${method} ${path} HTTP/1.1\r\nHost: x\r\n\r\n`);
      });
    },
    /** Whether the server closes the connection within `ms` from now */
    async closesWithin(ms: number) {
      await Promise.race([close, Bun.sleep(ms)]);
      if (!closed) socket.destroy();
      return closed;
    },
  };
}

test("Bun keeps an idle connection at least keepAliveTimeout plus its buffer, on its four-second ticks", () => {
  // Bun closes a socket whose idle timeout is s seconds on its tick
  // (s + 3) >> 2, which comes at most 4 s after the tick before it
  const earliestClose = (seconds: number) => (((seconds + 3) >> 2) - 1) * 4000;
  for (const buffer of [0, 1000]) {
    for (let ms = 1; ms + buffer <= 252_000; ms += 499) {
      const seconds = keepAliveIdleTimeout(ms, buffer);
      expect(seconds).toBeLessThanOrEqual(255);
      expect(earliestClose(seconds)).toBeGreaterThanOrEqual(ms + buffer);
      // and no later than the first tick that allows it
      expect(earliestClose(seconds) - 4000).toBeLessThan(ms + buffer);
    }
  }
  expect([
    // Node's defaults
    keepAliveIdleTimeout(5000, 1000),
    keepAliveIdleTimeout(4000, 0),
    keepAliveIdleTimeout(4000, 1000),
    keepAliveIdleTimeout(252_000, 0),
    // disabled, as in Node
    keepAliveIdleTimeout(0, 1000),
    // longer than Bun can wait: never closed rather than closed early
    keepAliveIdleTimeout(252_001, 0),
  ]).toEqual([12, 8, 12, 255, 0, 0]);
});

test.concurrent(
  "a keep-alive connection left idle after its reply is closed by the server",
  async () => {
    const { port } = await serve((_req, res) => res.end("done"));
    const connection = client(port);
    expect(await connection.request("/", "done")).toBe(true);
    expect(await connection.closesWithin(PAST_WINDOW)).toBe(true);
  },
  15_000,
);

test.concurrent(
  "a handler slower than the keep-alive timeout still delivers its reply",
  async () => {
    const { port } = await serve((_req, res) => {
      setTimeout(() => res.end("done"), PAST_WINDOW);
    });
    expect(await client(port).request("/", "done")).toBe(true);
  },
  15_000,
);

test.concurrent(
  "after an asynchronous reply the idle connection is still closed",
  async () => {
    const { port } = await serve((_req, res) => {
      setTimeout(() => res.end("done"), 50);
    });
    const connection = client(port);
    expect(await connection.request("/", "done")).toBe(true);
    expect(await connection.closesWithin(PAST_WINDOW)).toBe(true);
  },
  15_000,
);

test.concurrent(
  "after an asynchronous reply with its own Content-Type the idle connection is still closed",
  async () => {
    // Nest's replies set their type: Bun gets the body itself, not a stream
    const { port } = await serve((_req, res) => {
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end('{"done":true}');
      }, 50);
    });
    const connection = client(port);
    expect(await connection.request("/", '{"done":true}')).toBe(true);
    expect(await connection.closesWithin(PAST_WINDOW)).toBe(true);
  },
  15_000,
);

test.concurrent(
  "a streamed reply quiet for longer than the keep-alive timeout stays open until it ends",
  async () => {
    const { port } = await serve((_req, res) => {
      res.write("first");
      setTimeout(() => res.end("done"), PAST_WINDOW);
    });
    expect(await client(port).request("/", "done")).toBe(true);
  },
  15_000,
);

test.concurrent(
  "after a streamed reply that ended with chunks queued the idle connection is still closed",
  async () => {
    const { port } = await serve((_req, res) => {
      res.write("first");
      res.end("done");
    });
    const connection = client(port);
    expect(await connection.request("/", "done")).toBe(true);
    expect(await connection.closesWithin(PAST_WINDOW)).toBe(true);
  },
  15_000,
);

test.concurrent(
  "after a streamed reply that ended once its chunks were sent the idle connection is still closed",
  async () => {
    const { port } = await serve((_req, res) => {
      res.write("done");
      setTimeout(() => res.end(), 50);
    });
    const connection = client(port);
    expect(await connection.request("/", "done")).toBe(true);
    expect(await connection.closesWithin(PAST_WINDOW)).toBe(true);
  },
  15_000,
);

test.concurrent(
  "after a streamed reply that reached its Content-Length the idle connection is still closed",
  async () => {
    const { port } = await serve((_req, res) => {
      res.setHeader("content-length", "9");
      res.write("first");
      setTimeout(() => res.write("done"), 50);
    });
    const connection = client(port);
    expect(await connection.request("/", "done")).toBe(true);
    expect(await connection.closesWithin(PAST_WINDOW)).toBe(true);
  },
  15_000,
);

test.concurrent(
  "after an asynchronous streamed reply to a HEAD request the idle connection is still closed",
  async () => {
    const { port } = await serve((_req, res) => {
      setTimeout(() => {
        res.write("first");
        setTimeout(() => res.end(), 50);
      }, 50);
    });
    const connection = client(port);
    expect(await connection.request("/", "\r\n\r\n", "HEAD")).toBe(true);
    expect(await connection.closesWithin(PAST_WINDOW)).toBe(true);
  },
  15_000,
);

test.concurrent(
  "after a streamed reply to a HEAD request the idle connection is still closed",
  async () => {
    const { port } = await serve((_req, res) => {
      res.write("first");
      setTimeout(() => res.end(), 50);
    });
    const connection = client(port);
    expect(await connection.request("/", "\r\n\r\n", "HEAD")).toBe(true);
    expect(await connection.closesWithin(PAST_WINDOW)).toBe(true);
  },
  15_000,
);

test.concurrent(
  "a keepAliveTimeout of 0 keeps an idle connection open, as in Node",
  async () => {
    const { port } = await serve((_req, res) => res.end("done"), {
      keepAliveTimeout: 0,
    });
    const connection = client(port);
    expect(await connection.request("/", "done")).toBe(true);
    expect(await connection.closesWithin(PAST_WINDOW)).toBe(false);
  },
  15_000,
);

test.concurrent(
  "a keepAliveTimeout set after listen() applies to the connections served from then on",
  async () => {
    // Listening with 9 s, the server closes an idle connection 12 to 16 s
    // after its reply
    const { server, port } = await serve((_req, res) => res.end("done"), {
      keepAliveTimeout: 9000,
    });
    const before = client(port);
    expect(await before.request("/", "done")).toBe(true);
    server.keepAliveTimeout = 1;
    const after = client(port);
    expect(await after.request("/", "done")).toBe(true);
    expect(
      await Promise.all([
        before.closesWithin(PAST_WINDOW),
        after.closesWithin(PAST_WINDOW),
      ]),
    ).toEqual([false, true]);
  },
  15_000,
);

test.concurrent(
  "keepAliveTimeoutBuffer extends the wait, also when set after listen()",
  async () => {
    // 1 ms plus a buffer of 8 s: closed 12 to 16 s after a reply
    const { server, port } = await serve((_req, res) => res.end("done"), {
      keepAliveTimeout: 1,
      keepAliveTimeoutBuffer: 8000,
    });
    const before = client(port);
    expect(await before.request("/", "done")).toBe(true);
    server.keepAliveTimeoutBuffer = 0;
    const after = client(port);
    expect(await after.request("/", "done")).toBe(true);
    expect(
      await Promise.all([
        before.closesWithin(PAST_WINDOW),
        after.closesWithin(PAST_WINDOW),
      ]),
    ).toEqual([false, true]);
  },
  15_000,
);

test.concurrent(
  "an idle connection is still closed after closeAllConnections() replaced the listener",
  async () => {
    const { server, port } = await serve((_req, res) => res.end("done"));
    server.closeAllConnections();
    const connection = client(port);
    expect(await connection.request("/", "done")).toBe(true);
    expect(await connection.closesWithin(PAST_WINDOW)).toBe(true);
  },
  15_000,
);
