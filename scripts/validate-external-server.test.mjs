import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const validator = path.join(root, 'scripts/validate-external-server.mjs');
const recursiveIgnore = `
**/.git
**/.git/**
**/.env*
**/.npmrc
**/.pypirc
**/.ssh
**/.ssh/**
**/.runtime
**/.runtime/**
**/.venv
**/venv
**/*.pem
**/*.key
**/id_rsa*
**/id_ed25519*
**/secrets
**/secrets/**
**/.aws
**/.aws/**
**/.netrc
**/.git-credentials
**/.config/gcloud
**/.config/gcloud/**
`;
const baseEntry = {
  id: 'external-example',
  name: 'External example',
  description: 'A standalone MCP server.',
  version: '1.2.3',
  endpoint: { transport: 'streamable-http', url: 'https://mcp.example.test/mcp' },
  auth: {
    type: 'none',
    credentialModes: ['shared'],
    defaultCredentialMode: 'shared',
  },
};

async function fixture({
  entry = baseEntry,
  node = true,
  lock = true,
  ignore = recursiveIgnore,
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcp-external-validator-'));
  await Promise.all([
    writeFile(
      path.join(directory, 'Dockerfile'),
      'FROM scratch@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
    ),
    writeFile(path.join(directory, '.dockerignore'), ignore),
    writeFile(path.join(directory, 'catalog-entry.json'), JSON.stringify(entry)),
  ]);
  if (node) {
    await writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: 'external-example', version: '1.2.3' }),
    );
    if (lock) await writeFile(path.join(directory, 'package-lock.json'), '{}\n');
  }
  return directory;
}

function validate(directory) {
  return spawnSync(process.execPath, [validator, directory], { encoding: 'utf8' });
}

test('accepts the authoritative none and OAuth catalog shapes', async () => {
  const noneDirectory = await fixture();
  const oauthDirectory = await fixture({
    entry: {
      ...baseEntry,
      auth: {
        type: 'oauth',
        credentialModes: ['per_user'],
        defaultCredentialMode: 'per_user',
        oauthDefaults: {
          authorizationServerUrl: 'https://accounts.example.test',
          authorizationEndpoint: 'https://accounts.example.test/authorize',
          tokenEndpoint: 'https://accounts.example.test/token',
          scopes: ['contacts.read'],
        },
      },
    },
  });
  try {
    assert.equal(validate(noneDirectory).status, 0);
    assert.equal(validate(oauthDirectory).status, 0);
  } finally {
    await Promise.all([
      rm(noneDirectory, { recursive: true }),
      rm(oauthDirectory, { recursive: true }),
    ]);
  }
});

test('rejects entries outside the authoritative contract and URL rules', async () => {
  const missingName = { ...baseEntry };
  delete missingName.name;
  const malformedDirectory = await fixture({
    entry: {
      ...missingName,
      endpoint: { transport: 'streamable-http', url: 'ftp://localhost/mcp' },
      auth: { type: 'none', credentialModes: ['per_user'] },
    },
  });
  try {
    const result = validate(malformedDirectory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /authoritative catalog contract/);
  } finally {
    await rm(malformedDirectory, { recursive: true });
  }
});

test('requires a lockfile for Node projects and permits non-Node projects', async () => {
  const nodeDirectory = await fixture({ lock: false });
  const nonNodeDirectory = await fixture({ node: false });
  try {
    const missingLock = validate(nodeDirectory);
    assert.notEqual(missingLock.status, 0);
    assert.match(missingLock.stderr, /committed package-lock\.json/);
    assert.equal(validate(nonNodeDirectory).status, 0);
  } finally {
    await Promise.all([
      rm(nodeDirectory, { recursive: true }),
      rm(nonNodeDirectory, { recursive: true }),
    ]);
  }
});

test('rejects root-only Docker ignore rules', async () => {
  const directory = await fixture({ ignore: '.git\n.env*\n.npmrc\n.ssh\n.runtime\n' });
  try {
    const result = validate(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /recursive Docker context exclusion/);
  } finally {
    await rm(directory, { recursive: true });
  }
});
