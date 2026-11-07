import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('release tags select exactly one independently versioned image', async () => {
  const workflow = await read('.github/workflows/release.yml');
  assert.ok(workflow.includes("'*-v*'"));
  assert.match(workflow, /node scripts\/release-target\.mjs/);
  assert.match(
    workflow,
    /IMAGE: ghcr\.io\/dxheroes\/mcp-\$\{\{ needs\.validate\.outputs\.component \}\}/,
  );
  assert.doesNotMatch(workflow, /tags: \['v\*'\]/);
});

test('version checks compare every connector with its own metadata and catalog entries', async () => {
  const check = await read('scripts/check-versions.mjs');
  assert.match(check, /packageJson\.version !== metadataVersion/);
  assert.match(check, /versionsById/);
  assert.doesNotMatch(check, /packageJson\.version !== expected/);
});
