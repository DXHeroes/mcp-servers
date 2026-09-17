import { readdir, readFile } from 'node:fs/promises';

const readJson = async (url) => JSON.parse(await readFile(url, 'utf8'));
const connectorRoot = new URL('../connectors/', import.meta.url);
const connectorIds = (await readdir(connectorRoot)).sort();
const failures = [];
const versionsById = new Map();

for (const id of connectorIds) {
  const packageJson = await readJson(new URL(`${id}/package.json`, connectorRoot));
  const source = await readFile(new URL(`${id}/src/index.ts`, connectorRoot), 'utf8');
  const metadataVersion = source.match(/version:\s*['"]([^'"]+)['"]/)?.[1];
  versionsById.set(id, packageJson.version);
  if (packageJson.version !== metadataVersion)
    failures.push(
      `${id}: package ${packageJson.version}, metadata ${metadataVersion ?? 'missing'}`,
    );
}

const catalogFixture = await readJson(new URL('../fixtures/catalog.v1.json', import.meta.url));
for (const server of catalogFixture.servers) {
  const expected = versionsById.get(server.id);
  if (!expected) failures.push(`catalog fixture has unknown connector ${server.id}`);
  else if (server.version !== expected)
    failures.push(`catalog fixture ${server.id}: expected ${expected}, found ${server.version}`);
}

for (const name of ['kit', 'runtime', 'catalog', 'bundle']) {
  const pkg = await readJson(new URL(`../packages/${name}/package.json`, import.meta.url));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version))
    failures.push(`${pkg.name}: invalid independent version ${pkg.version}`);
}

const templatePackage = await readJson(
  new URL('../templates/typescript-crm/package.json', import.meta.url),
);
const templateCatalog = await readJson(
  new URL('../templates/typescript-crm/catalog-entry.json', import.meta.url),
);
if (templateCatalog.version !== templatePackage.version)
  failures.push(
    `CRM template: package ${templatePackage.version}, catalog ${templateCatalog.version}`,
  );

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Independent versions verified for ${connectorIds.length} connectors, shared packages and the CRM template`,
  );
}
