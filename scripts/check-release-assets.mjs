import { readFile, stat } from 'node:fs/promises';
import { missingRecursiveIgnores } from './docker-context-policy.mjs';
import { checkNativeReleaseWorkflow } from './native-release-policy.mjs';

const root = new URL('../', import.meta.url);
const expectedImages = [
  'abra-flexi',
  'byzdata',
  'fakturoid',
  'gemini-deep-research',
  'merk',
  'postgres',
  'toggl',
  'catalog',
  'bundle',
];
const failures = [];
const read = (name) => readFile(new URL(name, root), 'utf8');

const release = await read('.github/workflows/release.yml');
const ci = await read('.github/workflows/ci.yml');
const templateWorkflow = await read('templates/typescript-crm/.github/workflows/image.yml');
for (const [name, workflow] of [
  ['release', release],
  ['CI', ci],
  ['CRM template', templateWorkflow],
]) {
  const mutableActions = [...workflow.matchAll(/uses:\s*([^\s]+)@([^\s#]+)/g)].filter(
    ([, , ref]) => !/^[0-9a-f]{40}$/.test(ref),
  );
  if (mutableActions.length > 0)
    failures.push(
      `${name} workflow has mutable action refs: ${mutableActions.map((m) => m[0]).join(', ')}`,
    );
  if (!workflow.includes('persist-credentials: false'))
    failures.push(`${name} workflow must disable checkout credential persistence`);
}

const matrixEntries = [...release.matchAll(/- id: ([a-z-]+)\n\s+image: (\S+)/g)];
if (matrixEntries.length !== expectedImages.length * 2)
  failures.push('release must contain exactly nine build targets and nine final images');
for (const image of expectedImages) {
  const matches = matrixEntries.filter(
    ([, id, name]) => id === image && name === `ghcr.io/dxheroes/mcp-${image}`,
  );
  if (matches.length !== 2)
    failures.push(`release build and merge matrices must each contain ${image}`);
}
for (const platform of ['linux/amd64', 'linux/arm64']) {
  if (!release.includes(platform)) failures.push(`release scan is missing ${platform}`);
}
for (const required of [
  'version: v0.74.0',
  'cosign-release: v3.1.3',
  'version: v0.37.1',
  'moby/buildkit:v0.33.0@sha256:6c2fa84a6b61ccd72899dde4239f8d5717f05f9a8ca6f3cad185fb1a95a94de3',
  'docker/buildkit-syft-scanner:1.12.0@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9',
]) {
  for (const [name, workflow] of [
    ['release', release],
    ['CRM template', templateWorkflow],
  ]) {
    if (!workflow.includes(required)) failures.push(`${name} workflow is missing pin: ${required}`);
  }
}

for (const [name, workflow] of [
  ['release', release],
  ['CRM template', templateWorkflow],
]) {
  for (const failure of checkNativeReleaseWorkflow(workflow)) failures.push(`${name}: ${failure}`);
}

const templatePackage = JSON.parse(await read('templates/typescript-crm/package.json'));
const allTemplateDependencies = {
  ...templatePackage.dependencies,
  ...templatePackage.devDependencies,
};
for (const [name, version] of Object.entries(allTemplateDependencies)) {
  if (name.startsWith('@dxheroes/')) failures.push(`CRM template depends on unpublished ${name}`);
  if (String(version).startsWith('workspace:'))
    failures.push(`CRM template uses workspace dependency ${name}`);
}
const templateSource = await read('templates/typescript-crm/src/server.ts');
if (/from\s+['"](?:\.\.\/){3,}|\/Users\//.test(templateSource))
  failures.push('CRM template source imports outside its repository');
const templateDockerfile = await read('templates/typescript-crm/Dockerfile');
if (!/^COPY LICENSE \.\/LICENSE$/m.test(templateDockerfile))
  failures.push('CRM final image must include its source LICENSE');

const dockerignore = await read('.dockerignore');
for (const pattern of ['**/.git/**', '**/.env*', '**/.npmrc', '**/.ssh/**', '**/.runtime/**']) {
  if (!dockerignore.includes(pattern)) failures.push(`root .dockerignore is missing ${pattern}`);
}
const templateIgnore = await read('templates/typescript-crm/.dockerignore');
for (const pattern of missingRecursiveIgnores(templateIgnore))
  failures.push(`CRM .dockerignore is missing recursive rule ${pattern}`);

for (const file of [
  'README.md',
  'docs/architecture.md',
  'docs/security.md',
  'docs/contributing.md',
  'docs/releasing.md',
  'skills/mcp-server-create/SKILL.md',
  'skills/mcp-server-add/SKILL.md',
]) {
  if (!(await stat(new URL(file, root))).isFile()) failures.push(`missing release asset ${file}`);
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    'Release assets, workflow pins, image matrix and independent template boundaries verified',
  );
}
