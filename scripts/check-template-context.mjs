import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const template = path.join(root, 'templates/typescript-crm');
const directory = await mkdtemp(path.join(tmpdir(), 'mcp-crm-context-'));
const tag = `mcp-task3d/context-ignore-${randomUUID()}`;
const poisoned = [
  'src/vendor/.git/config',
  'src/vendor/.env.production',
  'src/vendor/.npmrc',
  'src/vendor/.ssh/id_rsa',
  'src/vendor/.runtime/token',
  'src/vendor/.aws/credentials',
  'src/vendor/.config/gcloud/credentials.db',
  'src/vendor/secrets/token',
  'src/vendor/client.pem',
  'src/vendor/client.key',
  'src/vendor/id_ed25519',
];

try {
  await writeFile(
    path.join(directory, '.dockerignore'),
    await readFile(path.join(template, '.dockerignore'), 'utf8'),
  );
  await writeFile(path.join(directory, 'visible.txt'), 'expected build input\n');
  for (const file of poisoned) {
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'synthetic poison marker\n');
  }
  const firstLine = (await readFile(path.join(template, 'Dockerfile'), 'utf8')).split(/\r?\n/)[0];
  const checks = poisoned.map((file) => `test ! -e /context/${file}`).join(' && ');
  await writeFile(
    path.join(directory, 'Dockerfile'),
    `${firstLine}\nWORKDIR /context\nCOPY . .\nRUN test -f /context/visible.txt && ${checks}\n`,
  );
  const result = spawnSync('docker', ['build', '--no-cache', '-t', tag, '.'], {
    cwd: directory,
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(`nested context exclusion build failed\n${result.stdout}\n${result.stderr}`);
  console.log('Synthetic nested metadata and secret paths were excluded from the Docker context');
} finally {
  spawnSync('docker', ['image', 'rm', '--force', tag], { encoding: 'utf8' });
  await rm(directory, { recursive: true, force: true });
}
