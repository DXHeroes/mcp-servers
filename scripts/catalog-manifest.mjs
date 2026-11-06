#!/usr/bin/env node
// Explicit catalog offer ID -> deployment URL. Packages supply static service declarations.
import { readFile } from 'node:fs/promises';
import { parseManifest } from '../packages/catalog/dist/index.js';
import { connectorIds } from './connector-inventory.mjs';

const endpoints = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!endpoints || typeof endpoints !== 'object' || Array.isArray(endpoints))
  throw new Error('Invalid deployment map');
const offers = new Map();
for (const id of await connectorIds()) {
  const mod = await import(`../connectors/${id}/dist/index.js`);
  const services = mod.endpoints ?? [{ path: '/mcp', package: mod.mcpPackage }];
  for (const service of services) {
    const m = service.package.metadata;
    if (offers.has(m.id)) throw new Error('Duplicate catalog offer ID');
    if ((service.auth === 'oauth') !== Boolean(m.oauthDefaults))
      throw new Error('OAuth services require explicit provider defaults and an OAuth endpoint');
    const auth =
      service.auth === 'oauth'
        ? {
            type: 'oauth',
            credentialModes: ['per_user'],
            defaultCredentialMode: 'per_user',
            credentialDelivery: 'connector_base64url',
            oauthDefaults: m.oauthDefaults,
          }
        : m.requiresApiKey
          ? {
              type: 'api_key',
              credentialModes: ['shared', 'per_user'],
              defaultCredentialMode: 'shared',
              credentialDelivery: 'connector_base64url',
              ...(m.credentialLabel ? { credentialLabel: m.credentialLabel } : {}),
              ...(m.apiKeyHint ? { apiKeyHint: m.apiKeyHint } : {}),
            }
          : { type: 'none', credentialModes: ['shared'], defaultCredentialMode: 'shared' };
    offers.set(m.id, {
      id: m.id,
      name: m.name,
      description: m.description,
      version: m.version,
      auth,
      ...(m.docsUrl ? { docsUrl: m.docsUrl.split('#')[0] } : {}),
      ...(m.author ? { author: m.author } : {}),
    });
  }
}
if (Object.keys(endpoints).some((id) => !offers.has(id)))
  throw new Error('Unknown catalog offer ID');
const servers = Object.entries(endpoints).map(([id, url]) => ({
  ...offers.get(id),
  endpoint: { transport: 'streamable-http', url },
}));
const manifest = JSON.stringify({ schemaVersion: 1, servers }, null, 2);
parseManifest(manifest);
console.log(manifest);
