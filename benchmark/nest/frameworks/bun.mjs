// A bare Bun.serve() handler: the ceiling of the runtime, not an application
const body = "Hello world!";
const headers = { "content-type": "text/plain; charset=utf-8" };
Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  development: false,
  idleTimeout: 0,
  fetch() {
    return new Response(body, { headers });
  },
});
