import { NodeAdapter } from '@nestjs/platform-node';
import { BunAdapter } from '../../src/index.js';
import { connect } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('./send-files/Readme.md', import.meta.url));

// These assertions make the transport differences visible: Bun's native HTTP
// parser/Request constructor has already changed or rejected the request before
// adapter code receives it. Neither adapter's router should silently erase them.
describe('Observable Bun.serve() transport boundaries against the published Node adapter', () => {
  const active: Array<NodeAdapter | BunAdapter> = [];
  const children: ChildProcess[] = [];
  const nativeServers: Bun.Server<unknown>[] = [];

  afterEach(async () => {
    await Promise.all(active.splice(0).map(adapter => adapter.close()));
    for (const child of children.splice(0)) child.kill();
    await Promise.all(nativeServers.splice(0).map(server => server.stop(true)));
  });

  async function bootNodeRuntime() {
    const child = spawn('node', ['--input-type=module', '-e', `
      import { NodeAdapter } from '@nestjs/platform-node';
      import { createReadStream, statSync } from 'node:fs';
      const adapter = new NodeAdapter();
      adapter.initHttpServer({});
      adapter.get('/empty', (_req, res) => res.writeHead(204, { 'Content-Length': '0' }).end());
      adapter.get('/stream', (_req, res) => { res.writeHead(200, { 'Content-Length': '4' }); res.write('bo'); setTimeout(() => res.end('dy'), 20); });
      adapter.get('/file', (_req, res) => { const file = process.cwd() + '/test/integration/send-files/Readme.md'; res.setHeader('Content-Length', statSync(file).size); createReadStream(file).pipe(res); });
      adapter.all('/{*path}', (req, res) => adapter.reply(res, { url: req.originalUrl, path: req.path }));
      adapter.listen(0, '127.0.0.1', () => console.log(adapter.getHttpServer().address().port));
    `], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    return new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.once('exit', code => reject(new Error(`Node fixture exited ${code}`)));
      child.stdout!.once('data', value => resolve(Number(String(value).trim())));
    });
  }

  async function boot(adapter: NodeAdapter | BunAdapter) {
    active.push(adapter);
    adapter.initHttpServer({});
    adapter.get('/empty', (_req: any, res: any) => res.writeHead(204, { 'Content-Length': '0' }).end());
    adapter.get('/stream', (_req: any, res: any) => { res.writeHead(200, { 'Content-Length': '4' }); res.write('bo'); setTimeout(() => res.end('dy'), 20); });
    adapter.get('/file', (_req: any, res: any) => { res.setHeader('Content-Length', statSync(FILE).size); createReadStream(FILE).pipe(res); });
    adapter.all('/{*path}', (req: any, res: any) =>
      adapter.reply(res, { url: req.originalUrl, path: req.path }),
    );
    await new Promise<void>(resolve => adapter.listen(0, '127.0.0.1', resolve));
    return (adapter.getHttpServer().address() as { port: number }).port;
  }

  function raw(port: number, target: string, method = 'GET') {
    return new Promise<{ status: number; body: string; headers: string }>((resolve, reject) => {
      let result = '';
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(`${method} ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      });
      socket.setEncoding('utf8');
      socket.on('data', chunk => (result += chunk));
      socket.on('error', reject);
      socket.on('end', () => {
        const [head, body = ''] = result.split('\r\n\r\n');
        resolve({ status: Number(head.split(' ')[1]), body, headers: head });
      });
    });
  }

  it.each([['*users', 'GET'], ['*', 'OPTIONS']])(
    'records native rejection of %s (%s), which Node routes to its final 404',
    async (target, method) => {
      const node = await raw(await bootNodeRuntime(), target, method);
      const nodeOnBun = await raw(await boot(new NodeAdapter()), target, method);
      const bun = await raw(await boot(new BunAdapter()), target, method);
      expect(node.status).toBe(404);
      expect(node.body).toContain(`Cannot ${method} ${target}`);
      expect(nodeOnBun.status).toBe(400);
      expect(bun.status).toBe(400);
    },
  );

  it('records native dot-segment normalization instead of claiming raw path parity', async () => {
    const node = await raw(await bootNodeRuntime(), '/a/../admin');
    const bun = await raw(await boot(new BunAdapter()), '/a/../admin');
    expect(node.status).toBe(200);
    expect(bun.status).toBe(200);
    expect(JSON.parse(node.body)).toEqual({ url: '/a/../admin', path: '/a/../admin' });
    expect(JSON.parse(bun.body)).toEqual({ url: '/admin', path: '/admin' });
  });

  it('records loss of the absolute-form authority while preserving the routed path', async () => {
    const target = 'http://original.example/users?x=1';
    const node = await raw(await bootNodeRuntime(), target);
    const bun = await raw(await boot(new BunAdapter()), target);
    expect(JSON.parse(node.body)).toEqual({ url: target, path: '/users' });
    expect(JSON.parse(bun.body)).toEqual({ url: '/users?x=1', path: '/users' });
  });

  it('records removal of Content-Length on 204 by the native Bun HTTP server', async () => {
    const node = await raw(await bootNodeRuntime(), '/empty');
    const bun = await raw(await boot(new BunAdapter()), '/empty');
    expect(node.status).toBe(204);
    expect(bun.status).toBe(204);
    expect(node.headers).toMatch(/content-length: 0/i);
    expect(bun.headers).not.toMatch(/content-length:/i);
  });

  it('proves native incremental streams use chunked framing even with a declared length', async () => {
    const native = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('bo'));
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode('dy'));
              controller.close();
            }, 20);
          },
        });
        return new Response(stream, { headers: { 'Content-Length': '4' } });
      },
    });
    nativeServers.push(native);
    const node = await raw(await bootNodeRuntime(), '/stream');
    const bun = await raw(await boot(new BunAdapter()), '/stream');
    const nativeResponse = await raw(native.port!, '/stream');
    expect(node.headers).toMatch(/content-length: 4/i);
    expect(node.body).toBe('body');
    for (const response of [bun, nativeResponse]) {
      expect(response.status).toBe(200);
      expect(response.headers).not.toMatch(/content-length:/i);
      expect(response.headers).toMatch(/transfer-encoding: chunked/i);
      expect(response.body).toContain('bo');
      expect(response.body).toContain('dy');
    }
  });

  it('keeps the declared length of a one-chunk file stream that a bare Bun.serve() stream loses', async () => {
    const expected = readFileSync(FILE);
    const native = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch: () => new Response(Readable.toWeb(createReadStream(FILE)) as ReadableStream, {
        headers: { 'Content-Length': String(expected.byteLength) },
      }),
    });
    nativeServers.push(native);
    const nodeResponse = await fetch(`http://127.0.0.1:${await bootNodeRuntime()}/file`);
    expect(nodeResponse.headers.get('content-length')).toBe(String(expected.byteLength));
    expect(Buffer.from(await nodeResponse.arrayBuffer())).toEqual(expected);
    // The adapter closes a streamed body once its declared length is in, so a
    // file that arrives in one chunk keeps its Content-Length where a bare
    // Bun.serve() stream loses it
    const adapted = await fetch(`http://127.0.0.1:${await boot(new BunAdapter())}/file`);
    expect(adapted.headers.get('content-length')).toBe(String(expected.byteLength));
    expect(Buffer.from(await adapted.arrayBuffer())).toEqual(expected);
    const bare = await fetch(`http://127.0.0.1:${native.port}/file`);
    expect(bare.headers.get('content-length')).toBeNull();
    expect(bare.headers.get('transfer-encoding')).toBe('chunked');
    expect(Buffer.from(await bare.arrayBuffer())).toEqual(expected);
  });
});
