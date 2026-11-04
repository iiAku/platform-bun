import { Controller, Get, Module, Req, Res, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NodeAdapter } from '@nestjs/platform-node';
import { BunAdapter } from '../../src/index.js';
import compression from 'compression';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { rateLimit } from 'express-rate-limit';
import { get } from 'node:http';
import { gunzipSync } from 'node:zlib';
import request from 'supertest';

const TEXT = 'Bun primitive transport and Nest middleware.\n'.repeat(512);
const SECRET = 'integration-test-cookie-secret';

@Controller()
class InteropController {
  @Get('text')
  text() { return TEXT; }

  @Get('session')
  session(@Req() req: any, @Res({ passthrough: true }) res: any) {
    req.session.views = (req.session.views ?? 0) + 1;
    res.cookie('token', 'signed-value', {
      signed: true,
      httpOnly: true,
      expires: new Date('2030-01-01T00:00:00Z'),
    });
    return { views: req.session.views, signed: req.signedCookies.token ?? null };
  }
}

@Module({ controllers: [InteropController] })
class InteropModule {}

describe.each([
  ['published platform-node on Bun', () => new NodeAdapter()],
  ['platform-bun', () => new BunAdapter()],
] as const)('Real Express middleware compatibility: %s', (_name, makeAdapter) => {
  let app: INestApplication;

  async function boot(configure: (app: INestApplication) => void) {
    const module = await Test.createTestingModule({ imports: [InteropModule] }).compile();
    app = module.createNestApplication(makeAdapter(), { logger: false });
    configure(app);
    await app.listen(0, '127.0.0.1');
    return app;
  }

  afterEach(async () => { await app?.close(); });

  it('compression emits actual gzip bytes that decompress to the controller response', async () => {
    await boot(app => app.use(compression({ threshold: 0 })));
    const response = await new Promise<{ headers: Record<string, any>; bytes: Buffer }>((resolve, reject) => {
      get(`${serverUrl()}/text`, { headers: { 'accept-encoding': 'gzip' } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve({ headers: res.headers, bytes: Buffer.concat(chunks) }));
        res.on('error', reject);
      }).on('error', reject);
    });
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers.vary).toContain('Accept-Encoding');
    expect([...response.bytes.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
    expect(gunzipSync(response.bytes).toString()).toBe(TEXT);
  });

  function serverUrl() {
    const address = app.getHttpServer().address();
    return `http://127.0.0.1:${address.port}`;
  }

  it('helmet applies its security headers to actual controller responses', async () => {
    await boot(app => app.use(helmet()));
    const response = await request(app.getHttpServer()).get('/text').expect(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.text).toBe(TEXT);
  });

  it('session persists across requests and signed cookies round-trip with separate Set-Cookie lines', async () => {
    await boot(app => {
      app.use(cookieParser(SECRET));
      app.use(session({ secret: SECRET, resave: false, saveUninitialized: false }));
    });
    const first = await request(app.getHttpServer()).get('/session').expect(200);
    expect(first.body).toEqual({ views: 1, signed: null });
    const cookies = first.headers['set-cookie'] as unknown as string[];
    expect(cookies).toHaveLength(2);
    const token = cookies.find(cookie => cookie.startsWith('token='))!;
    const sessionCookie = cookies.find(cookie => cookie.startsWith('connect.sid='))!;
    expect(token).toContain('Expires=Tue, 01 Jan 2030 00:00:00 GMT');
    expect(token).toContain('token=s%3A');
    expect(sessionCookie).toContain('connect.sid=s%3A');

    const second = await request(app.getHttpServer()).get('/session')
      .set('Cookie', cookies.map(cookie => cookie.split(';')[0]).join('; ')).expect(200);
    expect(second.body).toEqual({ views: 2, signed: 'signed-value' });

    const tampered = await request(app.getHttpServer()).get('/session')
      .set('Cookie', `${sessionCookie.split(';')[0]}; token=s%3Asigned-value.invalid`).expect(200);
    expect(tampered.body).toEqual({ views: 3, signed: false });
  });

  it('express-rate-limit counts the same client and returns 429 on the third request', async () => {
    await boot(app => app.use(rateLimit({ windowMs: 60_000, limit: 2, standardHeaders: 'draft-8', legacyHeaders: false })));
    await request(app.getHttpServer()).get('/text').expect(200);
    await request(app.getHttpServer()).get('/text').expect(200);
    const blocked = await request(app.getHttpServer()).get('/text').expect(429);
    expect(blocked.headers.ratelimit).toBeDefined();
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.text).toContain('Too many requests');
  });
});
