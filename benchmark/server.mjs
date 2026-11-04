// One real Nest application shared by all adapters. Manual decorator calls keep
// Node and Bun on the same JavaScript (no runtime-specific TS transform).
import "reflect-metadata";
import { Body, Controller, Get, Module, Param, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const target = process.argv[2] ?? "bun";
const port = Number(process.env.BENCH_PORT ?? 0);
const hostname = "127.0.0.1";
const hello = "Hello world!";
const user = (id) => ({
  id,
  name: "John Doe",
  email: "john@example.com",
  roles: ["admin", "user"],
});
let close;
let server;
if (target === "raw-bun") {
  if (typeof Bun === "undefined") throw new Error("raw-bun requires Bun");
  server = Bun.serve({
    hostname,
    port,
    development: false,
    idleTimeout: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/")
        return new Response(hello, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      if (request.method === "GET" && path.startsWith("/users/"))
        return Response.json(user(path.slice(7)));
      if (request.method === "POST" && path === "/echo")
        return request
          .json()
          .then((body) => Response.json(body, { status: 201 }));
      return new Response("Not Found", { status: 404 });
    },
  });
  close = () => server.stop(true);
} else {
  const adapters = {
    bun: async () => new (await import("../dist/index.js")).BunAdapter(),
    node: async () => new (await import("@nestjs/platform-node")).NodeAdapter(),
    express: async () =>
      new (await import("@nestjs/platform-express")).ExpressAdapter(),
    fastify: async () =>
      new (await import("@nestjs/platform-fastify")).FastifyAdapter(),
  };
  if (!adapters[target]) throw new Error(`Unknown adapter: ${target}`);
  class AppController {
    hello() {
      return hello;
    }
    user(id) {
      return user(id);
    }
    echo(body) {
      return body;
    }
  }
  function route(decorator, name, parameter) {
    const prototype = AppController.prototype;
    decorator(
      prototype,
      name,
      Object.getOwnPropertyDescriptor(prototype, name),
    );
    parameter?.(prototype, name, 0);
    Reflect.defineMetadata("design:paramtypes", [Object], prototype, name);
  }
  route(Get(), "hello");
  route(Get("users/:id"), "user", Param("id"));
  route(Post("echo"), "echo", Body());
  Controller()(AppController);
  class AppModule {}
  Module({ controllers: [AppController] })(AppModule);
  const app = await NestFactory.create(AppModule, await adapters[target](), {
    logger: false,
  });
  await app.listen(port, hostname);
  server = app.getHttpServer();
  close = () => app.close();
}
// Bun.serve() exposes its address as an object, node:http-style servers as a method
const address =
  typeof server.address === "function" ? server.address() : server.address;
process.stdout.write(
  JSON.stringify({
    ready: true,
    port: address?.port ?? server.port,
    pid: process.pid,
    runtime:
      typeof Bun === "undefined"
        ? `Node ${process.version}`
        : `Bun ${Bun.version}`,
    target,
    serverClass: server.constructor.name,
    backend:
      target === "bun"
        ? "Bun.serve"
        : target === "raw-bun"
          ? "Bun.serve (raw)"
          : "node:http",
  }) + "\n",
);
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await close();
    process.exit(0);
  });
