#!/usr/bin/env node
// Input is an explicit JSON map of connector ID -> deployment URL. No discovery scans.
import { readFile } from 'node:fs/promises';

const ids = [
  'abra-flexi',
  'byzdata',
  'fakturoid',
  'gemini-deep-research',
  'merk',
  'postgres',
  'toggl',
];
const endpoints = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (Object.keys(endpoints).some((id) => !ids.includes(id))) throw new Error('Unknown connector ID');
const servers = [];
for (const id of ids) {
  if (endpoints[id] === undefined) continue;
  const {
    mcpPackage: { metadata: m },
  } = await import(`../connectors/${id}/dist/index.js`);
  servers.push({
    id,
    name: m.name,
    description: m.description,
    version: m.version,
    endpoint: { transport: 'streamable-http', url: endpoints[id] },
    auth: m.requiresApiKey
      ? {
          type: 'api_key',
          credentialModes: ['shared', 'per_user'],
          defaultCredentialMode: 'shared',
          credentialDelivery: 'connector_base64url',
          ...(m.credentialLabel ? { credentialLabel: m.credentialLabel } : {}),
          ...(m.apiKeyHint ? { apiKeyHint: m.apiKeyHint } : {}),
        }
      : { type: 'none', credentialModes: ['shared'], defaultCredentialMode: 'shared' },
    ...(m.docsUrl ? { docsUrl: m.docsUrl.split('#')[0] } : {}),
    ...(m.author ? { author: m.author } : {}),
  });
}
const manifest = JSON.stringify({ schemaVersion: 1, servers }, null, 2);
const { parseManifest } = await import('../packages/catalog/dist/index.js');
parseManifest(manifest);
console.log(manifest);
