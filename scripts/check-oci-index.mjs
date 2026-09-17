import { readFile } from 'node:fs/promises';

const index = JSON.parse(await readFile(process.argv[2], 'utf8'));
const images = new Map();
const attested = new Set();
for (const manifest of index.manifests ?? []) {
  const platform = manifest.platform ?? {};
  if (platform.os === 'linux' && ['amd64', 'arm64'].includes(platform.architecture))
    images.set(`${platform.os}/${platform.architecture}`, manifest.digest);
  if (manifest.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest') {
    const subject = manifest.annotations['vnd.docker.reference.digest'];
    if (subject) attested.add(subject);
  }
}
for (const platform of ['linux/amd64', 'linux/arm64']) {
  const digest = images.get(platform);
  if (!digest) throw new Error(`OCI index is missing ${platform}`);
  if (!attested.has(digest))
    throw new Error(`OCI index has no attestation manifest for ${platform}`);
}
console.log('OCI index contains amd64 and arm64 images with per-platform attestations');
