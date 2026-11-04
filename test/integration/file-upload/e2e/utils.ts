import type { INestApplication, Type } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { NodeAdapter } from '../../../../src/index.js';
import { Test } from '@nestjs/testing';
import { listenOnLoopback } from '../../_support/listen-on-loopback.js';

export type AdapterName = 'express' | 'node';

export const PNG = Buffer.from(
  // 1x1 transparent PNG, so FileTypeValidator's magic-number check runs for real
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export const txt = (filename: string) => ({
  filename,
  contentType: 'text/plain',
});

/**
 * Boots `module` on the given adapter and listens on an ephemeral port on
 * 127.0.0.1 (see `listenOnLoopback()`). On Fastify, `@fastify/multipart` is
 * registered by the adapter; `setup` runs before `app.init()`, `afterInit`
 * between it and `listen()`.
 */
export async function createApp(
  adapterName: AdapterName,
  module: Type<unknown>,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [module],
  }).compile();
  const app = moduleRef.createNestApplication(adapterName === 'express' ? new ExpressAdapter() : new NodeAdapter());
  await listenOnLoopback(app);
  return app;
}
