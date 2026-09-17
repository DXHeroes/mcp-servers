#!/usr/bin/env node
import { loadConfig } from '@dxheroes/mcp-runtime';
import { createCatalogServer } from './server.js';

try {
  const path = process.env.MCP_CATALOG_MANIFEST;
  if (!path) throw new Error();
  const publicMetadata = process.env.MCP_CATALOG_PUBLIC === 'true';
  // Public catalog metadata is an explicit deployment decision, independent of connector auth.
  const config = await loadConfig(
    publicMetadata
      ? {
          ...process.env,
          MCP_ACCESS_TOKEN: 'public-catalog-placeholder',
          MCP_ACCESS_TOKEN_FILE: undefined,
        }
      : process.env,
  );
  if (publicMetadata) config.accessToken = undefined;
  const server = createCatalogServer(path, config);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      server.closeAllConnections();
      server.close();
    });
} catch {
  console.error('Catalog startup failed; check explicit manifest and authentication configuration');
  process.exitCode = 1;
}
