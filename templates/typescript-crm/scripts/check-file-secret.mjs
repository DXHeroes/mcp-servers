import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const image = process.argv[2] ?? 'mcp-crm:test';
const suffix = randomUUID();
const volume = `mcp-crm-secret-${suffix}`;
const container = `mcp-crm-file-secret-${suffix}`;
const token = 'synthetic-file-secret';

const sourceLicense = await readFile(new URL('../LICENSE', import.meta.url));
const imageLicense = spawnSync(
  'docker',
  ['run', '--rm', '--entrypoint', 'cat', image, '/app/LICENSE'],
  { maxBuffer: sourceLicense.length + 1024 },
);
if (imageLicense.status !== 0)
  throw new Error(
    `cannot read image LICENSE\n${imageLicense.stdout.toString()}\n${imageLicense.stderr.toString()}`,
  );
if (!sourceLicense.equals(imageLicense.stdout))
  throw new Error('image /app/LICENSE differs from the template LICENSE');
console.log('Image LICENSE exactly matches the template LICENSE');

function run(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', ...options });
  if (result.status !== 0)
    throw new Error(`docker ${args[0]} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

try {
  run(['volume', 'create', volume]);
  run([
    'run',
    '--rm',
    '--user',
    '0:0',
    '--entrypoint',
    '/bin/sh',
    '-e',
    `SYNTHETIC_TOKEN=${token}`,
    '-v',
    `${volume}:/seed`,
    image,
    '-c',
    'printf \'%s\' "$SYNTHETIC_TOKEN" > /seed/access-token && chown 0:65532 /seed/access-token && chmod 0440 /seed/access-token',
  ]);
  run([
    'run',
    '-d',
    '--name',
    container,
    '--user',
    '65532:65532',
    '--read-only',
    '-p',
    '127.0.0.1::8080',
    '-e',
    'MCP_ACCESS_TOKEN_FILE=/run/secrets/access-token',
    '-e',
    'MCP_ALLOWED_HOSTS=127.0.0.1',
    '-v',
    `${volume}:/run/secrets:ro`,
    image,
  ]);
  const address = run(['port', container, '8080/tcp']);
  const port = address.slice(address.lastIndexOf(':') + 1);
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Startup can race the first few requests.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) {
    const logs = spawnSync('docker', ['logs', container], { encoding: 'utf8' });
    throw new Error(
      `non-root file-secret container did not become ready\n${logs.stdout}\n${logs.stderr}`,
    );
  }
  console.log('Group-readable file secret started under uid/gid 65532');
} finally {
  spawnSync('docker', ['rm', '--force', container], { encoding: 'utf8' });
  spawnSync('docker', ['volume', 'rm', '--force', volume], { encoding: 'utf8' });
}
