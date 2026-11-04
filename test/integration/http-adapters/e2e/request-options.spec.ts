import type { INestApplication } from '@nestjs/common';
import { NodeAdapter } from '../../../../src/index.js';
import qs from 'qs';
import request from 'supertest';
import { adapters, createApp } from '../src/adapters.js';
import { RequestOptionsModule } from '../src/request-options/request-options.module.js';

// Each adapter set up to trust the proxy on the loopback interface, where the
// test requests come from: Express through its "trust proxy" setting,
// Fastify and Node through their "trustProxy" option
const trustingLoopback = () => createApp('node', RequestOptionsModule, undefined, {}, new NodeAdapter({ trustProxy: 'loopback' }));
const parsingWithQs = () => createApp('node', RequestOptionsModule, undefined, {}, new NodeAdapter({ querystringParser: str => qs.parse(str) }));

const FORWARDED = {
  'X-Forwarded-For': '203.0.113.7',
  'X-Forwarded-Proto': 'https',
  'X-Forwarded-Host': 'example.com',
};

const QUERY = 'filter[where][name]=John&item[]=1&item[]=2';

describe.each(adapters('express', 'fastify', 'node'))(
  'Adapter options for requests (%s)',
  name => {
    let app: INestApplication;

    afterEach(async () => {
      await app.close();
    });

    it('should read the client address, protocol and host a trusted proxy forwards', async () => {
      app = await trustingLoopback();

      const res = await request(app.getHttpServer())
        .get('/client')
        .set(FORWARDED);

      expect(res.body).toEqual({
        ip: '203.0.113.7',
        protocol: 'https',
        hostname: 'example.com',
      });
    });

    it('should ignore the X-Forwarded-* headers by default', async () => {
      app = await createApp(name, RequestOptionsModule);

      const res = await request(app.getHttpServer())
        .get('/client')
        .set(FORWARDED);

      expect(res.body).toEqual({
        ip: '127.0.0.1',
        protocol: 'http',
        hostname: '127.0.0.1',
      });
    });

    it('should parse nested objects and arrays in the query string with the parser it is given', async () => {
      app = await parsingWithQs();

      const res = await request(app.getHttpServer()).get(`/search?${QUERY}`);

      expect(res.body).toEqual({
        filter: { where: { name: 'John' } },
        item: ['1', '2'],
      });
    });

    it('should leave the query string flat by default', async () => {
      app = await createApp(name, RequestOptionsModule);

      const res = await request(app.getHttpServer()).get(`/search?${QUERY}`);

      expect(res.body).toEqual({
        'filter[where][name]': 'John',
        'item[]': ['1', '2'],
      });
    });
  },
);
