import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Inventory comes from checked-in workspace directories, not from request/tag path fragments. */
export async function connectorIds(root = new URL('../', import.meta.url)) {
  const directory = new URL('connectors/', root);
  const ids = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-z][a-z0-9-]*$/.test(entry.name)) continue;
    const pkg = JSON.parse(
      await readFile(new URL(`${entry.name}/package.json`, directory), 'utf8'),
    );
    if (pkg.name !== `@dxheroes/mcp-${entry.name}` || pkg.mcpPackage !== true)
      throw new Error('Invalid connector package metadata');
    ids.push(entry.name);
  }
  return ids.sort();
}
export async function assertConnector(id, root) {
  if (!(await connectorIds(root)).includes(id)) throw new Error('Unknown connector ID');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await assertConnector(process.argv[2]);
