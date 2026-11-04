import type { HttpServer, INestApplication } from "@nestjs/common";
import type { CorsOptions, CorsOptionsDelegate } from "@nestjs/common/internal";
import type { BunHttpServer } from "../transport/bun-http-server.js";
import type { BunHttpsServer } from "../transport/bun-https-server.js";
import type { BunRequest, BunResponse } from "../adapters/bun-request.js";
import type { BunRouter } from "../router/bun-router.js";
import type {
  NestBunBodyParserOptionsFor,
  NestBunBodyParserType,
} from "./nest-bun-body-parser.interface.js";
import type { ServeStaticOptions } from "./serve-static-options.interface.js";
import type { BunViewOptions } from "../views/view-renderer.js";

/**
 * Interface describing methods on NestBunApplication.
 *
 * @see [Platform](https://docs.nestjs.com/first-steps#platform)
 *
 * @publicApi
 */
export interface NestBunApplication<
  TServer extends BunHttpServer | BunHttpsServer = BunHttpServer,
> extends INestApplication<TServer> {
  getHttpAdapter(): HttpServer<BunRequest, BunResponse, BunRouter>;

  listen(port: number | string, callback?: () => void): Promise<TServer>;
  listen(
    port: number | string,
    hostname: string,
    callback?: () => void,
  ): Promise<TServer>;

  useStaticAssets(path: string, options?: ServeStaticOptions): this;

  enableCors(options?: CorsOptions | CorsOptionsDelegate<any>): void;

  /**
   * Configures the template engine used by `@Render()`, either with
   * `@fastify/view`-style options (`{ engine: { ejs: require('ejs') },
   * templates: 'views' }`) or with an engine name, as with Express.
   */
  setViewEngine(options: BunViewOptions | string): this;

  /**
   * Sets the directory (or directories) views are resolved against.
   */
  setBaseViewsDir(path: string | string[]): this;

  useBodyParser<ParserType extends NestBunBodyParserType>(
    parser: ParserType,
    options?: NestBunBodyParserOptionsFor<ParserType>,
  ): this;
}
