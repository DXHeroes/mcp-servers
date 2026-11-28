import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { connectorIds } from './connector-inventory.mjs';
import { releaseTarget } from './release-target.mjs';

test('a new connector resolves its release target by its own version without changing an ID allowlist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'connector-inventory-'));
  try {
    await mkdir(join(dir, 'connectors/new-service'), { recursive: true });
    await writeFile(
      join(dir, 'connectors/new-service/package.json'),
      JSON.stringify({ name: '@dxheroes/mcp-new-service', version: '0.2.0', mcpPackage: true }),
    );
    const root = pathToFileURL(`${dir}/`);
    assert.deepEqual(await connectorIds(root), ['new-service']);
    assert.deepEqual(await releaseTarget('new-service-v0.2.0', root), {
      component: 'new-service',
      version: '0.2.0',
      image: 'ghcr.io/dxheroes/mcp-new-service',
      dockerfile: 'Dockerfile.connector',
      build_args: 'CONNECTOR=new-service',
    });
    for (const tag of [
      'unknown-v0.2.0',
      'new-service-v0.2.0\n',
      '../new-service-v0.2.0',
      'new-service-v0.3.0',
      'new-service-v0.2.0\noutput=bad',
    ])
      await assert.rejects(() => releaseTarget(tag, root));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Google connector release uses its independent version and image without npm publication', async () => {
  assert.deepEqual(await releaseTarget('google-v0.5.0'), {
    component: 'google',
    version: '0.5.0',
    image: 'ghcr.io/dxheroes/mcp-google',
    dockerfile: 'Dockerfile.connector',
    build_args: 'CONNECTOR=google',
  });
  await assert.rejects(() => releaseTarget('google-v0.2.0'));
});

test('the root build includes every standalone connector project', async () => {
  const config = JSON.parse(await readFile(new URL('../tsconfig.json', import.meta.url), 'utf8'));
  const projects = config.references.map(({ path }) => path);
  for (const id of await connectorIds()) {
    assert.ok(projects.includes(`./connectors/${id}`), `Missing build reference for ${id}`);
  }
});
