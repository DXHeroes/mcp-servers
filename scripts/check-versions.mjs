import { readdir, readFile } from 'node:fs/promises';

const root = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const expected = root.version;
const kit = JSON.parse(
  await readFile(new URL('../packages/kit/package.json', import.meta.url), 'utf8'),
);
const runtimePackages = await Promise.all(
  ['runtime', 'catalog', 'bundle'].map(async (name) =>
    JSON.parse(
      await readFile(new URL(`../packages/${name}/package.json`, import.meta.url), 'utf8'),
    ),
  ),
);
const connectorRoot = new URL('../connectors/', import.meta.url);
const connectorIds = (await readdir(connectorRoot)).sort();
const failures = [];

for (const [name, value] of [
  ['root', root.version],
  ['@dxheroes/mcp-kit', kit.version],
  ...runtimePackages.map((pkg) => [pkg.name, pkg.version]),
]) {
  if (value !== expected) failures.push(`${name}: expected ${expected}, found ${value}`);
}

for (const id of connectorIds) {
  const packageJson = JSON.parse(
    await readFile(new URL(`${id}/package.json`, connectorRoot), 'utf8'),
  );
  const source = await readFile(new URL(`${id}/src/index.ts`, connectorRoot), 'utf8');
  const metadataVersion = source.match(/version:\s*['"]([^'"]+)['"]/)?.[1];
  if (packageJson.version !== expected) failures.push(`${id} package: ${packageJson.version}`);
  if (metadataVersion !== expected)
    failures.push(`${id} metadata: ${metadataVersion ?? 'missing'}`);
}

const catalogFixture = JSON.parse(
  await readFile(new URL('../fixtures/catalog.v1.json', import.meta.url), 'utf8'),
);
for (const server of catalogFixture.servers) {
  if (server.version !== expected)
    failures.push(`catalog fixture ${server.id}: expected ${expected}, found ${server.version}`);
}

const templatePackage = JSON.parse(
  await readFile(new URL('../templates/typescript-crm/package.json', import.meta.url), 'utf8'),
);
const templateCatalog = JSON.parse(
  await readFile(
    new URL('../templates/typescript-crm/catalog-entry.json', import.meta.url),
    'utf8',
  ),
);
if (templatePackage.version !== expected)
  failures.push(`CRM template package: expected ${expected}, found ${templatePackage.version}`);
if (templateCatalog.version !== expected)
  failures.push(`CRM template catalog: expected ${expected}, found ${templateCatalog.version}`);

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Version consistency verified for runtime, catalog fixtures, CRM template and ${connectorIds.length} connectors: ${expected}`,
  );
}
