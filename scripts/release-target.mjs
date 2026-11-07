import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { assertConnector } from './connector-inventory.mjs';

export async function releaseTarget(tag, root = new URL('../', import.meta.url)) {
  const match = /^([a-z][a-z0-9-]*)-v(\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9.-]+)?)$/.exec(tag);
  if (!match || match[0] !== tag) throw new Error('Invalid component tag');
  const [, component, version] = match;
  const auxiliary = component === 'catalog' || component === 'bundle';
  if (!auxiliary) await assertConnector(component, root);
  const pkg = JSON.parse(
    await readFile(
      new URL(`${auxiliary ? 'packages' : 'connectors'}/${component}/package.json`, root),
      'utf8',
    ),
  );
  if (pkg.version !== version) throw new Error('Component tag does not match its package version');
  return {
    component,
    version,
    image: `ghcr.io/dxheroes/mcp-${component}`,
    dockerfile: auxiliary ? `Dockerfile.${component}` : 'Dockerfile.connector',
    build_args: auxiliary ? '' : `CONNECTOR=${component}`,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [key, value] of Object.entries(await releaseTarget(process.argv[2])))
    console.log(`${key}=${value}`);
}
