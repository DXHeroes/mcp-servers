import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const architectures = ['amd64', 'arm64'];
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const requireDigest = (value) => {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value))
    throw new Error('expected an immutable sha256 digest');
  return value;
};

export function checkIndex(index) {
  if (index.schemaVersion !== 2 || !Array.isArray(index.manifests))
    throw new Error('expected an OCI image index');
  const images = new Map();
  const attested = new Set();
  for (const manifest of index.manifests) {
    requireDigest(manifest.digest);
    if (manifest.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest') {
      attested.add(requireDigest(manifest.annotations['vnd.docker.reference.digest']));
      continue;
    }
    const platform = manifest.platform ?? {};
    if (platform.os !== 'linux' || !architectures.includes(platform.architecture))
      throw new Error('unexpected image platform');
    if (images.has(platform.architecture)) throw new Error('duplicate image platform');
    images.set(platform.architecture, manifest.digest);
  }
  for (const architecture of architectures) {
    const digest = images.get(architecture);
    if (!digest) throw new Error(`OCI index is missing linux/${architecture}`);
    if (!attested.has(digest))
      throw new Error(`OCI index has no attestation manifest for linux/${architecture}`);
  }
}

function checkReceipt(receipt, image, revision) {
  if (receipt.image !== image || receipt.revision !== revision)
    throw new Error('build receipt image or source revision differs');
  if (!architectures.includes(receipt.architecture))
    throw new Error('unexpected build architecture');
  requireDigest(receipt.digest);
}

async function main([command, ...args]) {
  if (command === 'record') {
    const [image, revision, architecture, digest] = args;
    const receipt = { image, revision, architecture, digest };
    checkReceipt(receipt, image, revision);
    console.log(JSON.stringify(receipt));
  } else if (command === 'sources') {
    const [image, revision, ...files] = args;
    if (files.length !== 2) throw new Error('merge requires exactly two build receipts');
    const receipts = await Promise.all(files.map(readJson));
    for (const receipt of receipts) checkReceipt(receipt, image, revision);
    if (new Set(receipts.map((r) => r.architecture)).size !== 2)
      throw new Error('merge requires both native architectures');
    if (new Set(receipts.map((r) => r.digest)).size !== 2)
      throw new Error('merge requires distinct platform subjects');
    for (const architecture of architectures) {
      console.log(`${image}@${receipts.find((r) => r.architecture === architecture).digest}`);
    }
  } else if (command === 'digest') {
    const metadata = await readJson(args[0]);
    console.log(requireDigest(metadata['containerimage.descriptor']?.digest));
  } else if (command === 'index') {
    checkIndex(await readJson(args[0]));
    console.log('OCI index contains both native platforms with per-platform attestations');
  } else {
    throw new Error('expected record, sources, digest or index command');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.argv.slice(2));
