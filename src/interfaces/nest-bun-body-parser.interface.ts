import type {
  BunBodyParserOptions,
  BunJsonParserOptions,
  BunTextParserOptions,
  BunUrlencodedParserOptions,
} from "../body-parser/body-parser.js";

/**
 * Options of each body parser that `useBodyParser()` accepts.
 *
 * @publicApi
 */
export interface NestBunBodyParserOptionsMap {
  json: BunJsonParserOptions;
  urlencoded: BunUrlencodedParserOptions;
  text: BunTextParserOptions;
  raw: BunBodyParserOptions;
}

/**
 * @publicApi
 */
export type NestBunBodyParserType = keyof NestBunBodyParserOptionsMap;

/**
 * @publicApi
 */
export type NestBunBodyParserOptionsFor<
  ParserType extends NestBunBodyParserType,
> = Omit<NestBunBodyParserOptionsMap[ParserType], "verify">;

export type {
  BunBodyParserOptions,
  BunJsonParserOptions,
  BunTextParserOptions,
  BunUrlencodedParserOptions,
};
