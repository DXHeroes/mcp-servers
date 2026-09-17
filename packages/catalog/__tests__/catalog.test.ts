import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parseManifest } from '../src/manifest.js';
import { createCatalogServer } from '../src/server.js';

const fixture = await readFile(
  new URL('../../../fixtures/catalog.v1.json', import.meta.url),
  'utf8',
);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.reverse()) await close();
  cleanups.length = 0;
});
it('validates frozen fixture, duplicates, URLs, credentials and schema refinements', () => {
  expect(parseManifest(fixture).servers).toHaveLength(7);
  const data = JSON.parse(fixture);
  data.servers.push(data.servers[0]);
  expect(() => parseManifest(JSON.stringify(data))).toThrow();
  data.servers.pop();
  for (const url of ['file:///etc/passwd', 'https://user:password@host/mcp', 'https://ho st/mcp']) {
    data.servers[0].endpoint.url = url;
    expect(() => parseManifest(JSON.stringify(data))).toThrow();
  }
  const blank = JSON.parse(fixture);
  blank.servers[0].name = '   ';
  expect(() => parseManifest(JSON.stringify(blank))).toThrow();
  for (const auth of [
    { type: 'none', credentialModes: ['per_user'] },
    {
      type: 'api_key',
      credentialModes: ['shared', 'shared'],
      credentialDelivery: 'connector_base64url',
    },
    {
      type: 'api_key',
      credentialModes: ['shared'],
      credentialDelivery: 'connector_base64url',
      apiKeyDefaults: { headerName: 'Authorization', headerValueTemplate: '{apiKey}' },
    },
  ]) {
    const f = JSON.parse(fixture);
    f.servers[0].auth = auth;
    expect(() => parseManifest(JSON.stringify(f))).toThrow();
  }
  expect(() => parseManifest('schemaVersion: 1\nservers: []\nservers: []')).toThrow();
  expect(() => parseManifest('x'.repeat(2097153))).toThrow();
});
it('serves only valid snapshots and fails discovery/readiness during invalid updates, then repairs/empties', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-catalog-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'manifest.yaml');
  await writeFile(file, fixture);
  const server = createCatalogServer(file, {
    accessToken: 'catalog-test-only',
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: [],
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = () =>
    fetch(`${base}/catalog/v1/servers`, { headers: { Authorization: 'Bearer catalog-test-only' } });
  expect((await fetch(`${base}/catalog/v1/servers`)).status).toBe(401);
  expect((await (await get()).json()).servers).toHaveLength(7);
  await writeFile(file, 'secret-invalid-input');
  expect((await get()).status).toBe(503);
  const health = await fetch(`${base}/health`);
  expect(health.status).toBe(503);
  expect(await health.text()).not.toContain('secret');
  await writeFile(file, 'schemaVersion: 1\nservers: []\n');
  expect(await (await get()).json()).toEqual({ schemaVersion: 1, servers: [] });
  await rm(file);
  expect((await get()).status).toBe(503);
  await writeFile(file, fixture);
  expect((await get()).status).toBe(200);
});
