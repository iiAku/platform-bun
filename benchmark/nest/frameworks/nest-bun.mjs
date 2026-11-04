import { NestFactory } from "@nestjs/core";
import { BunAdapter } from "../../../dist/index.js";
import { AppModule, options, port } from "./nest/app.mjs";

const app = await NestFactory.create(AppModule, new BunAdapter(), options);
await app.listen(port);
