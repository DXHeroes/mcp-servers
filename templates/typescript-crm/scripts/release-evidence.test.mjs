import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = new URL('./release-evidence.mjs', import.meta.url).pathname;
const image = 'ghcr.io/example/mcp-crm';
const revision = 'a'.repeat(40);
const digest = (char) => `sha256:${char.repeat(64)}`;
const receipt = (architecture, char) => ({ image, revision, architecture, digest: digest(char) });
const platform = (architecture, char) => ({
  mediaType: 'application/vnd.oci.image.manifest.v1+json',
  digest: digest(char),
  size: 1234,
  platform: { os: 'linux', architecture },
});
const attestation = (subject, char) => ({
  ...platform('unknown', char),
  platform: { os: 'unknown', architecture: 'unknown' },
  annotations: {
    'vnd.docker.reference.type': 'attestation-manifest',
    'vnd.docker.reference.digest': digest(subject),
  },
});
const index = () => ({
  schemaVersion: 2,
  mediaType: 'application/vnd.oci.image.index.v1+json',
  manifests: [
    platform('amd64', '1'),
    attestation('1', '2'),
    platform('arm64', '3'),
    attestation('3', '4'),
  ],
});

async function run(command, values, args = []) {
  const directory = await mkdtemp(path.join(tmpdir(), 'release-evidence-'));
  try {
    const files = await Promise.all(
      values.map(async (value, i) => {
        const file = path.join(directory, `${i}.json`);
        await writeFile(file, JSON.stringify(value));
        return file;
      }),
    );
    return spawnSync(process.execPath, [script, command, ...args, ...files], { encoding: 'utf8' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('merge inputs are immutable subjects from both native builds of one revision', async () => {
  const result = await run(
    'sources',
    [receipt('arm64', '3'), receipt('amd64', '1')],
    [image, revision],
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${image}@${digest('1')}\n${image}@${digest('3')}\n`);
});
for (const [name, values] of [
  ['missing architecture', [receipt('amd64', '1')]],
  ['duplicate architecture', [receipt('amd64', '1'), receipt('amd64', '3')]],
  ['wrong architecture', [receipt('amd64', '1'), receipt('s390x', '3')]],
  ['duplicate subject', [receipt('amd64', '1'), receipt('arm64', '1')]],
  [
    'wrong revision',
    [receipt('amd64', '1'), { ...receipt('arm64', '3'), revision: 'b'.repeat(40) }],
  ],
  [
    'wrong image',
    [receipt('amd64', '1'), { ...receipt('arm64', '3'), image: 'ghcr.io/other/image' }],
  ],
  ['malformed digest', [receipt('amd64', '1'), { ...receipt('arm64', '3'), digest: 'latest' }]],
]) {
  test(`rejects ${name} before assembling an index`, async () => {
    assert.notEqual((await run('sources', values, [image, revision])).status, 0);
  });
}

test('accepts a merged OCI index with attestation descriptors for each subject', async () => {
  const result = await run('index', [index()]);
  assert.equal(result.status, 0, result.stderr);
});
for (const [name, mutate] of [
  ['missing platform', (value) => value.manifests.splice(2, 2)],
  [
    'wrong platform',
    (value) => {
      value.manifests[2].platform.architecture = 's390x';
    },
  ],
  ['duplicate platform', (value) => value.manifests.push(platform('arm64', '5'))],
  ['missing attestation', (value) => value.manifests.splice(3, 1)],
  [
    'wrong attestation subject',
    (value) => {
      value.manifests[3].annotations['vnd.docker.reference.digest'] = digest('9');
    },
  ],
]) {
  test(`rejects final index with ${name}`, async () => {
    const value = index();
    mutate(value);
    assert.notEqual((await run('index', [value])).status, 0);
  });
}

test('reads the immutable final index digest from imagetools metadata', async () => {
  const result = await run('digest', [
    {
      'containerimage.descriptor': {
        mediaType: 'application/vnd.oci.image.index.v1+json',
        digest: digest('5'),
        size: 4654,
      },
      'image.name': image,
    },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${digest('5')}\n`);
});
for (const value of [{}, { 'containerimage.descriptor': { digest: 'latest' } }]) {
  test('refuses missing or mutable merge result instead of signing a tag', async () => {
    assert.notEqual((await run('digest', [value])).status, 0);
  });
}
