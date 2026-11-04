import { INestApplication } from '@nestjs/common';
import { NodeAdapter } from '../../../../../src/index.js';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';

describe('Listen (Node Application)', () => {
  let testModule: TestingModule;
  let app: INestApplication;

  beforeEach(async () => {
    testModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = testModule.createNestApplication(new NodeAdapter());
  });

  afterEach(async () => {
    await app.close();
  });

  it('should resolve with httpServer on success', async () => {
    const response = await app.listen(0);
    expect(response).toEqual(app.getHttpServer());
  });

  it('should reject if the port is not available', async () => {
    await app.listen(0);
    const secondApp = testModule.createNestApplication(new NodeAdapter());
    await expect(secondApp.listen(app.getHttpServer().address().port)).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });

  it('should reject if there is an invalid host', async () => {
    await expect(app.listen(0, '1')).rejects.toMatchObject({
      code: 'EADDRNOTAVAIL',
    });
  });
});
