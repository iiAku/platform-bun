/*
 * Nest @platform-node
 * Copyright(c) 2017 - 2025 Kamil Mysliwiec
 * https://nestjs.com
 * MIT Licensed
 */

export * from "./adapters/index.js";
export * from "./interfaces/index.js";
export * from "./multer/index.js";
export { BunRouter } from "./router/bun-router.js";
export type { BunViewOptions } from "./views/view-renderer.js";

// Source-compatible names ease migrations from platform-node.
export { BunAdapter as NodeAdapter } from "./adapters/bun-adapter.js";
export {
  BunRequest as NodeRequest,
  BunResponse as NodeResponse,
} from "./adapters/bun-request.js";
export { BunRouter as NodeRouter } from "./router/bun-router.js";
export type {
  BunAdapterOptions as NodeAdapterOptions,
  BunTrustProxy as NodeTrustProxy,
} from "./interfaces/bun-adapter-options.interface.js";
export type { NestBunApplication as NestNodeApplication } from "./interfaces/nest-bun-application.interface.js";
export type { BunViewOptions as NodeViewOptions } from "./views/view-renderer.js";
export {
  BunHttpServer,
  type BunHttpServerOptions,
} from "./transport/bun-http-server.js";

export type {
  BunCookieOptions as NodeCookieOptions,
  BunSendFileOptions as NodeSendFileOptions,
} from "./adapters/bun-request.js";
export type {
  NestBunBodyParserOptionsMap as NestNodeBodyParserOptionsMap,
  NestBunBodyParserOptionsFor as NestNodeBodyParserOptionsFor,
  NestBunBodyParserType as NestNodeBodyParserType,
} from "./interfaces/nest-bun-body-parser.interface.js";
export type {
  BunBodyParserOptions as NodeBodyParserOptions,
  BunJsonParserOptions as NodeJsonParserOptions,
  BunTextParserOptions as NodeTextParserOptions,
  BunUrlencodedParserOptions as NodeUrlencodedParserOptions,
  BunPoisoningAction as NodePoisoningAction,
  BunPrototypePoisoningOptions as NodePrototypePoisoningOptions,
} from "./body-parser/body-parser.js";

export { BunHttpsServer } from "./transport/bun-https-server.js";
