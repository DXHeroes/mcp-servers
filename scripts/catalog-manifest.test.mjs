import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
test('generates OAuth service offers without a package-level API-key alias', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-offers-'));
  try {
    const file = join(dir, 'deploy.json');
    await writeFile(
      file,
      JSON.stringify({
        'google-tasks': 'https://connector.example/tasks/mcp',
        toggl: 'https://toggl.example/mcp',
        'google-gmail-send': 'https://connector.example/gmail/mcp',
      }),
    );
    const { stdout } = await exec(process.execPath, ['scripts/catalog-manifest.mjs', file]);
    const offers = JSON.parse(stdout).servers;
    assert.equal(offers[0].id, 'google-tasks');
    assert.equal(offers[0].auth.type, 'oauth');
    assert.deepEqual(offers[0].auth.credentialModes, ['per_user']);
    assert.equal(offers[0].auth.credentialDelivery, 'connector_base64url');
    assert.deepEqual(offers[0].auth.oauthDefaults.scopes, [
      'https://www.googleapis.com/auth/tasks',
    ]);
    assert.equal(offers[0].auth.oauthDefaults.authorizeParams.access_type, 'offline');
    assert.equal(offers[1].auth.type, 'api_key');
    assert.equal(offers[2].id, 'google-gmail-send');
    assert.equal(offers[2].auth.type, 'oauth');
    assert.deepEqual(offers[2].auth.oauthDefaults.scopes, [
      'https://www.googleapis.com/auth/gmail.send',
    ]);
    for (const map of [
      { google: 'https://connector.example/mcp' },
      { unknown: 'https://connector.example/mcp' },
      { 'google-tasks': 'https://connector.example/tasks/mcp?token=secret' },
    ]) {
      await writeFile(file, JSON.stringify(map));
      await assert.rejects(() => exec(process.execPath, ['scripts/catalog-manifest.mjs', file]));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
