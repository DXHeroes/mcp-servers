#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { loadConfig, readSecret } from '@dxheroes/mcp-runtime';
import { parseBundle } from './config.js';
import { createBundle } from './router.js';

try {
  const config = await loadConfig();
  if (!process.env.MCP_BUNDLE_MANIFEST || !config.accessToken) throw new Error();
  const catalogAccessToken = await readSecret(process.env, 'MCP_CATALOG_ACCESS_TOKEN');
  if (!catalogAccessToken) throw new Error();
  const manifest = await parseBundle(
    await readFile(process.env.MCP_BUNDLE_MANIFEST, 'utf8'),
    config.accessToken,
    process.env,
    catalogAccessToken,
  );
  const bundle = createBundle(manifest, { ...config, catalogAccessToken });
  await new Promise<void>((resolve, reject) => {
    bundle.server.once('error', reject);
    bundle.server.listen(config.port, config.host, resolve);
  });
  bundle.start();
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 10000);
    await bundle.close();
    clearTimeout(deadline);
  };
  process.once('SIGTERM', () => {
    void stop();
  });
  process.once('SIGINT', () => {
    void stop();
  });
} catch {
  console.error('bundle_start_failed');
  process.exitCode = 1;
}
