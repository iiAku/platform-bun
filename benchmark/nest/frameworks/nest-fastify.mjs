import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { AppModule, options, port } from "./nest/app.mjs";

const app = await NestFactory.create(AppModule, new FastifyAdapter(), options);
await app.listen(port);
