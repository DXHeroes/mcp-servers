import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const entry = JSON.parse(await readFile(new URL('../catalog-entry.json', import.meta.url), 'utf8'));
if (entry.version !== pkg.version) throw new Error('package and catalog versions must match');
const tag = process.env.MCP_RELEASE_TAG;
if (tag && tag !== `v${pkg.version}`)
  throw new Error(`release tag ${tag} must equal v${pkg.version}`);
if (entry.endpoint?.transport !== 'streamable-http' || !new URL(entry.endpoint.url))
  throw new Error('invalid catalog endpoint');
if (entry.auth?.type !== 'none' || JSON.stringify(entry.auth.credentialModes) !== '["shared"]')
  throw new Error('CRM template must advertise no upstream credential');
const deployment = await readFile(
  new URL('../deployment/kubernetes.yaml', import.meta.url),
  'utf8',
);
if (!/image:\s+\S+@sha256:[0-9a-f]{64}/.test(deployment))
  throw new Error('deployment image must use a digest');
if (!deployment.includes('imagePullSecrets:'))
  throw new Error('registry pull secret example missing');
for (const field of ['runAsUser: 65532', 'runAsGroup: 65532', 'fsGroup: 65532']) {
  if (!deployment.includes(field)) throw new Error(`deployment missing ${field}`);
}
if (!deployment.includes('defaultMode: 0440'))
  throw new Error('projected secret must be group-readable and not world-readable');
console.log('CRM versions, catalog entry and digest-pinned deployment example verified');
