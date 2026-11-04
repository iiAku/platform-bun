import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { AppModule, options, port } from "./nest/app.mjs";

const app = await NestFactory.create(AppModule, new ExpressAdapter(), options);
await app.listen(port);
