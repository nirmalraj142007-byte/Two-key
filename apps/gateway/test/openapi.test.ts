import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { buildOpenApiDocument, ROUTES } from '../src/openapi.js';

describe('API docs', () => {
  const dev = buildApp({ LOG_LEVEL: 'silent', NODE_ENV: 'development' });
  const prod = buildApp({ LOG_LEVEL: 'silent', NODE_ENV: 'production' });
  afterAll(async () => {
    await Promise.all([dev.close(), prod.close()]);
  });

  it('serves the OpenAPI document and Swagger UI outside production', async () => {
    const json = await dev.inject({ method: 'GET', url: '/docs/json' });
    expect(json.statusCode).toBe(200);
    expect(
      json.json().paths['/agent/proposals'].post.requestBody.content['application/json'].schema,
    ).toMatchObject({ required: ['product_id', 'qty'] });
    const ui = await dev.inject({ method: 'GET', url: '/docs' });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers['content-type']).toMatch(/^text\/html/);
  });

  it('has no /docs in production', async () => {
    const res = await prod.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('documents no agent route beyond the fixed four-tool surface', () => {
    const agent = ROUTES.filter((r) => r.audience === 'agent').map((r) => `${r.method} ${r.path}`);
    expect(agent.sort()).toEqual([
      'get /agent/catalog/search',
      'get /agent/purchases/{proposalId}',
      'get /agent/rules',
      'post /agent/proposals',
    ]);
  });

  it('docs/openapi.json is up to date (npm run openapi:export)', () => {
    const committed = readFileSync(new URL('../../../docs/openapi.json', import.meta.url), 'utf8');
    expect(committed).toBe(`${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
  });
});
