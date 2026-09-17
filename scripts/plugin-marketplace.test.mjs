import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('publishes the mcp-servers Claude marketplace and plugin', async () => {
  const marketplace = JSON.parse(await read('.claude-plugin/marketplace.json'));
  assert.equal(marketplace.name, 'mcp-servers');
  assert.deepEqual(
    marketplace.plugins.map(({ name, source }) => ({ name, source })),
    [{ name: 'mcp-servers', source: './plugin' }],
  );

  const plugin = JSON.parse(await read('plugin/.claude-plugin/plugin.json'));
  assert.equal(plugin.name, 'mcp-servers');
  assert.equal(plugin.version, '0.1.0');
  assert.equal(plugin.license, 'Apache-2.0');
});
test('generated plugin skills match their canonical portable skills', async () => {
  const mappings = [
    ['mcp-server-create', 'create'],
    ['mcp-server-add', 'add'],
    ['mcp-server-deploy', 'deploy'],
  ];

  for (const [canonicalName, pluginName] of mappings) {
    const canonical = await read(`skills/${canonicalName}/SKILL.md`);
    const generated = await read(`plugin/skills/${pluginName}/SKILL.md`);
    assert.equal(generated, canonical.replace(`name: ${canonicalName}`, `name: ${pluginName}`));
  }
});
