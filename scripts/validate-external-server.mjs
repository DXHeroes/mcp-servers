#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { missingRecursiveIgnores } from './docker-context-policy.mjs';

const project = path.resolve(process.argv[2] ?? '.');
const catalogPath = path.resolve(process.argv[3] ?? path.join(project, 'catalog-entry.json'));
const failures = [];
const text = async (name) => readFile(path.join(project, name), 'utf8');

for (const file of ['Dockerfile', '.dockerignore']) {
  try {
    if (!(await stat(path.join(project, file))).isFile()) failures.push(`${file} is not a file`);
  } catch {
    failures.push(`${file} is required`);
  }
}

let packageSource;
try {
  packageSource = await text('package.json');
} catch (error) {
  if (error?.code !== 'ENOENT') failures.push(`cannot read package.json: ${error.message}`);
}
if (packageSource !== undefined) {
  try {
    const pkg = JSON.parse(packageSource);
    for (const [name, version] of Object.entries({
      ...pkg.dependencies,
      ...pkg.devDependencies,
    })) {
      if (name.startsWith('@dxheroes/'))
        failures.push(`unpublished dependency is not portable: ${name}`);
      if (String(version).startsWith('workspace:'))
        failures.push(`workspace dependency is not portable: ${name}`);
    }
  } catch (error) {
    failures.push(`invalid package.json: ${error.message}`);
  }
  try {
    if (!(await stat(path.join(project, 'package-lock.json'))).isFile())
      failures.push('Node template requires a committed package-lock.json');
  } catch (error) {
    if (error?.code === 'ENOENT')
      failures.push('Node template requires a committed package-lock.json');
    else failures.push(`cannot inspect package-lock.json: ${error.message}`);
  }
}

try {
  const ignore = await text('.dockerignore');
  for (const pattern of missingRecursiveIgnores(ignore))
    failures.push(`.dockerignore needs recursive Docker context exclusion ${pattern}`);
} catch {
  // Missing file is already reported.
}

try {
  const dockerfile = await text('Dockerfile');
  if (!/@sha256:[0-9a-f]{64}/.test(dockerfile))
    failures.push('Dockerfile base image is not digest-pinned');
  if (/\b(?:git clone|curl .+\|\s*(?:sh|bash)|wget .+\|\s*(?:sh|bash))\b/i.test(dockerfile))
    failures.push('Dockerfile contains an unreviewed remote execution pattern');
} catch {
  // Missing file is already reported.
}

try {
  const entry = JSON.parse(await readFile(catalogPath, 'utf8'));
  const { parseManifest } = await import('../packages/catalog/dist/index.js');
  parseManifest(JSON.stringify({ schemaVersion: 1, servers: [entry] }));
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND')
    failures.push('authoritative catalog validator is unavailable; build the verified kit first');
  else failures.push(`catalog entry violates the authoritative catalog contract: ${error.message}`);
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`External MCP server assets verified: ${project}`);
}
