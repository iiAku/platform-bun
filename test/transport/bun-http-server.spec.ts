import { afterEach, expect, test } from "bun:test";
import { IncomingMessage, ServerResponse, get as httpGet } from "node:http";
import { BunHttpServer } from "../../src/transport/bun-http-server";

let server: BunHttpServer | undefined;
afterEach(async () => {
  await new Promise<void>(
    (resolve) => server?.close(() => resolve()) ?? resolve(),
  );
});

async function start(
  listener: (req: IncomingMessage, res: ServerResponse) => void,
) {
  server = new BunHttpServer(listener);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address()!.port}`;
}

test("Bun native transport preserves stream request bodies and repeated response cookies", async () => {
  const url = await start((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("Set-Cookie", ["a=1", "b=2"]);
      res.writeHead(201, { "Content-Type": "application/octet-stream" });
      res.end(Buffer.concat(chunks));
    });
  });
  const response = await fetch(`${url}/echo?x=1`, {
    method: "POST",
    body: "hello",
  });
  expect(response.status).toBe(201);
  expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  expect(await response.text()).toBe("hello");
  expect(server!.nativeServer).toBeDefined();
});

test("streaming flushes before end and emits finish once", async () => {
  let finish = 0;
  const url = await start((_req, res) => {
    res.on("finish", () => finish++);
    res.setHeader("Content-Type", "text/plain");
    res.write("first");
    setTimeout(() => res.end("last"), 30);
  });
  const response = await fetch(url);
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("last");
  expect((await reader.read()).done).toBe(true);
  expect(finish).toBe(1);
});

test("HEAD and no-content responses discard body bytes", async () => {
  const url = await start((req, res) => {
    res.writeHead(req.url === "/empty" ? 204 : 200, { "Content-Length": "5" });
    res.end("hello");
  });
  const head = await fetch(url, { method: "HEAD" });
  expect(head.headers.get("Content-Length")).toBe("5");
  expect(await head.text()).toBe("");
  const empty = await fetch(`${url}/empty`);
  expect(empty.status).toBe(204);
  expect(await empty.text()).toBe("");
});

test("raw end preserves absence of Content-Type and correct bytes", async () => {
  const url = await start((_req, res) => res.end("hello"));
  const response = await fetch(url);
  expect(response.headers.get("Content-Type")).toBeNull();
  expect(await response.text()).toBe("hello");
});

test("destroying one pending response closes its connection and leaves other requests available", async () => {
  const url = await start((req, res) => {
    if (req.url === "/abort") res.destroy();
    else res.end("alive");
  });
  await expect(fetch(`${url}/abort`)).rejects.toThrow();
  expect(await (await fetch(`${url}/ok`)).text()).toBe("alive");
});

test("closeAllConnections aborts active responses while the server keeps accepting requests", async () => {
  let received!: () => void;
  const active = new Promise<void>((resolve) => {
    received = resolve;
  });
  const url = await start((req, res) => {
    if (req.url === "/hold") received();
    else res.end("alive");
  });
  const held = new Promise((resolve, reject) => {
    httpGet(`${url}/hold`, { agent: false }, resolve).on("error", reject);
  });
  held.catch(() => {});
  await active;
  server!.closeAllConnections();
  await expect(held).rejects.toThrow();
  expect(await (await fetch(`${url}/ok`)).text()).toBe("alive");
});
