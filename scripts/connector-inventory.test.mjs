import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
