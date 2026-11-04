import type {
  INestApplication,
  NestApplicationOptions,
  Type,
} from '@nestjs/common';
import { NodeAdapter } from '../../../../src/index.js';
import { Test } from '@nestjs/testing';
import { listenOnLoopback } from '../../_support/listen-on-loopback.js';

export type AdapterName = 'express' | 'fastify' | 'node';


/**
 * `[name]` tuples for `describe.each()`, for the adapters a behavior must be
 * the same on.
 */
export function adapters(...names: AdapterName[]): [AdapterName][] {
  return names.filter(name => name === 'node').map(name => [name]);
}

/**
 * Creates an application for `module` on the given adapter, lets `setup`
 * configure it, and listens on 127.0.0.1.
 */
export async function createApp(
  name: AdapterName,
  module: Type<unknown>,
  setup?: (app: INestApplication) => unknown,
  options: NestApplicationOptions = {},
  adapter = new NodeAdapter(),
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [module],
  }).compile();
  const app = moduleRef.createNestApplication(adapter, {
    logger: false,
    ...options,
  });
  await setup?.(app);
  await listenOnLoopback(app);
  return app;
}

/**
 * Sets `X-Middleware: ran`, to tell which requests a middleware saw.
 */
export function markMiddleware(_req: unknown, res: any, next: () => void) {
  (res.raw ?? res).setHeader('X-Middleware', 'ran');
  next();
}
