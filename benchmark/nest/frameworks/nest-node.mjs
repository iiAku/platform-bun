import { NestFactory } from "@nestjs/core";
import { NodeAdapter } from "@nestjs/platform-node";
import { AppModule, options, port } from "./nest/app.mjs";

const app = await NestFactory.create(AppModule, new NodeAdapter(), options);
await app.listen(port);
