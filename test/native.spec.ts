import { BunAdapter } from '../src/index.js';
describe('Bun-native server contract', () => {
  it('serves through Bun.serve and a native Response while preserving adapter helpers', async () => {
    const adapter = new BunAdapter();
    adapter.initHttpServer({});
    try {
      adapter.get('/hello/:name', (req, res) => res.json({ hello: req.params.name, query: req.query }));
      await new Promise<void>(resolve => adapter.listen(0, '127.0.0.1', resolve));
      const server = adapter.getHttpServer() as any;
      expect(server.nativeServer).toBeDefined();
      expect(typeof server.nativeServer.requestIP).toBe('function');
      const result = await fetch(`http://127.0.0.1:${server.address().port}/hello/Bun?q=1`);
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ hello: 'Bun', query: {q:'1'} });
    } finally { await adapter.close(); }
  });
});
