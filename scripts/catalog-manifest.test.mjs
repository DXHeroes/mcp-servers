import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
        'google-gmail-read': 'https://connector.example/gmail-read/mcp',
        'google-search-console': 'https://connector.example/search-console/mcp',
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
    const search = offers.find(({ id }) => id === 'google-search-console');
    assert.equal(search.endpoint.url, 'https://connector.example/search-console/mcp');
    assert.equal(search.auth.type, 'oauth');
    assert.deepEqual(search.auth.credentialModes, ['per_user']);
    assert.equal(search.auth.credentialDelivery, 'connector_base64url');
    assert.deepEqual(search.auth.oauthDefaults.scopes, [
      'https://www.googleapis.com/auth/webmasters.readonly',
    ]);
    assert.deepEqual(search.auth.oauthDefaults.authorizeParams, {
      access_type: 'offline',
      prompt: 'consent select_account',
    });
    assert.equal(offers[1].auth.type, 'api_key');
    assert.equal(offers[2].id, 'google-gmail-send');
    assert.equal(offers[2].auth.type, 'oauth');
    assert.deepEqual(offers[2].auth.oauthDefaults.scopes, [
      'https://www.googleapis.com/auth/gmail.send',
    ]);
    assert.equal(offers[3].id, 'google-gmail-read');
    assert.equal(offers[3].endpoint.url, 'https://connector.example/gmail-read/mcp');
    assert.equal(offers[3].auth.type, 'oauth');
    assert.deepEqual(offers[3].auth.credentialModes, ['per_user']);
    assert.deepEqual(offers[3].auth.oauthDefaults.scopes, [
      'https://www.googleapis.com/auth/gmail.readonly',
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

test('the example deployment advertises both Gemini connectors with Gateway credential delivery', async () => {
  const { stdout } = await exec(process.execPath, [
    'scripts/catalog-manifest.mjs',
    'fixtures/deployment-endpoints.example.json',
  ]);
  const generated = JSON.parse(stdout).servers;
  const frozen = JSON.parse(
    await readFile(new URL('../fixtures/catalog.v1.json', import.meta.url), 'utf8'),
  ).servers;
  for (const id of ['gemini-decisions', 'gemini-deep-research']) {
    const offer = generated.find((server) => server.id === id);
    assert.ok(offer, `Missing catalog offer for ${id}`);
    assert.equal(offer.auth.type, 'api_key');
    assert.equal(offer.auth.defaultCredentialMode, 'shared');
    assert.deepEqual(offer.auth.credentialModes, ['shared', 'per_user']);
    assert.equal(offer.auth.credentialDelivery, 'connector_base64url');
    assert.deepEqual(
      offer,
      frozen.find((server) => server.id === id),
    );
  }
});
