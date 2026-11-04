import Fastify from "fastify";

const app = Fastify({ logger: false });
app.get("/", (_request, reply) => reply.send("Hello world!"));
await app.listen({ port: Number(process.env.PORT ?? 3000) });
