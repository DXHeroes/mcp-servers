import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, it, vi } from 'vitest';
import { parseBundle } from '../src/config.js';
import { createBundle } from '../src/router.js';

const root = resolve(import.meta.dirname, '..');
const edge = 'regression-execution-synthetic';
const catalog = 'regression-catalog-synthetic';
const config = {
  host: '127.0.0.1',
  port: 0,
  allowedHosts: ['127.0.0.1'],
  allowedOrigins: [],
  accessToken: edge,
  catalogAccessToken: catalog,
  localTestMode: false,
  maxBodyBytes: 2097152,
  totalTimeoutMs: 5000,
  idleTimeoutMs: 3000,
};
async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
function offer(id: string, modes: ('shared' | 'per_user')[] = ['shared']) {
  return {
    id,
    name: id,
    description: 'Review regression fixture',
    version: '1',
    endpoint: { transport: 'streamable-http', url: `http://127.0.0.1/mcp/${id}` },
    auth: { type: 'api_key', credentialDelivery: 'connector_base64url', credentialModes: modes },
  };
}
async function connect(
  url: string,
  id: string,
  mode: 'shared' | 'per_user' = 'shared',
  modern = false,
) {
  const c = new Client(
    { name: 'review-regression', version: '1' },
    modern ? { versionNegotiation: { mode: 'auto' } } : {},
  );
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp/${id}`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${edge}`,
          'X-MCP-Credential-Mode': mode,
          ...(mode === 'per_user'
            ? {
                'X-MCP-Upstream-Credential':
                  Buffer.from('personal-synthetic').toString('base64url'),
              }
            : {}),
        },
      },
    }),
  );
  return c;
}
function dead(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

it('keeps the actual bundle CLI and native sibling alive across repeated stdin callback/event failures', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'bundle-pipe-regression-'));
  const pidFile = resolve(dir, 'child-pids');
  const manifestPath = resolve(dir, 'bundle.json');
  const port = await freePort();
  const servicePort = await freePort();
  await writeFile(pidFile, '');
  await writeFile(
    manifestPath,
    JSON.stringify({
      catalog: { schemaVersion: 1, servers: [offer('broken'), offer('healthy')] },
      services: [
        {
          id: 'broken',
          transport: 'stdio',
          argv: ['/usr/bin/python3', resolve(root, '__tests__/fixtures/closed-stdin.py')],
          cwd: root,
          env: { PROBE_PID_FILE: pidFile },
          maxActive: 1,
        },
        {
          id: 'healthy',
          transport: 'http',
          argv: [process.execPath, resolve(root, 'dist/fixture.js')],
          cwd: root,
          env: {},
          port: servicePort,
        },
      ],
    }),
  );
  const bundle = spawn(process.execPath, [resolve(root, 'dist/cli.js')], {
    cwd: root,
    env: {
      MCP_BUNDLE_MANIFEST: manifestPath,
      MCP_ACCESS_TOKEN: edge,
      MCP_CATALOG_ACCESS_TOKEN: catalog,
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(port),
      MCP_ALLOWED_HOSTS: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  for (const output of [bundle.stdout, bundle.stderr])
    output.on('data', (chunk) => {
      logs = (logs + chunk.toString()).slice(-32768);
    });
  const exited = new Promise<void>((r) => {
    bundle.once('exit', () => r());
    bundle.once('error', () => r());
  });
  const url = `http://127.0.0.1:${port}`;
  const health = async () => {
    const r = await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${edge}` } });
    expect(r.status).toBe(200);
    return r.json();
  };
  const clients: Client[] = [];
  let siblingPid: number | undefined;
  try {
    await vi.waitFor(async () => expect((await health()).services.healthy.status).toBe('ready'), {
      timeout: 10000,
    });
    const healthy = await connect(url, 'healthy');
    clients.push(healthy);
    const before = await healthy.callTool({ name: 'context_echo' });
    siblingPid = JSON.parse((before.content[0] as { text: string }).text).pid;
    const broken = await connect(url, 'broken');
    clients.push(broken);
    for (let attempt = 0; attempt < 3; attempt++) {
      let failed = false;
      try {
        await broken.listTools({}, { timeout: 2000 });
      } catch (error) {
        failed = true;
        expect(String(error)).not.toMatch(
          /EPIPE|synthetic-private-child-diagnostic|closed-stdin.py/,
        );
      }
      expect(failed).toBe(true);
      await vi.waitFor(async () => {
        expect(bundle.exitCode).toBeNull();
        expect(bundle.signalCode).toBeNull();
        expect((await health()).active.broken).toBe(0);
        const pids = (await readFile(pidFile, 'utf8')).trim().split('\n').map(Number);
        expect(pids).toHaveLength(attempt + 1);
        for (const pid of pids) expect(dead(pid)).toBe(true);
      });
      expect((await healthy.listTools()).tools[0]?.name).toBe('context_echo');
    }
    expect(logs).toBe('');
    for (const c of clients) await c.close();
    bundle.kill('SIGTERM');
    await exited;
    expect(bundle.exitCode).toBe(0);
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    bundle.kill('SIGTERM');
    const deadline = setTimeout(() => bundle.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(deadline);
    const pids = (await readFile(pidFile, 'utf8')).trim().split('\n').filter(Boolean).map(Number);
    for (const pid of [...pids, ...(siblingPid ? [siblingPid] : [])]) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already reaped */
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);

it('enforces personal-only mode before credential selection or native/stdio dispatch on every MCP route method', async () => {
  const services = [
    {
      id: 'native',
      transport: 'http',
      argv: [process.execPath, resolve(root, 'dist/fixture.js')],
      cwd: root,
      env: {},
      port: await freePort(),
      requestCredentials: 'connector_base64url',
      sharedCredential: { env: 'SHARED' },
    },
    {
      id: 'stdio',
      transport: 'stdio',
      argv: [process.execPath, resolve(root, 'dist/fixture.js'), '--stdio'],
      cwd: root,
      env: {},
      requestCredentials: 'connector_base64url',
      sharedCredential: { env: 'SHARED' },
    },
  ];
  const manifest = await parseBundle(
    JSON.stringify({
      catalog: { schemaVersion: 1, servers: services.map((s) => offer(s.id, ['per_user'])) },
      services,
    }),
    edge,
    { SHARED: 'must-not-select-deployment-secret' },
    catalog,
  );
  let sharedSelections = 0;
  for (const s of manifest.services)
    Object.defineProperty(s, 'sharedCredential', {
      get: () => {
        sharedSelections++;
        return 'must-not-select-deployment-secret';
      },
    });
  const bundle = createBundle(manifest, config);
  bundle.start();
  await new Promise<void>((r) => bundle.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(bundle.server.address() as { port: number }).port}`;
  const clients: Client[] = [];
  try {
    await vi.waitFor(() => expect(bundle.supervisor.states.get('native')?.status).toBe('ready'));
    const invalidHeaders: Record<string, string>[] = [
      {},
      { 'X-MCP-Credential-Mode': 'shared' },
      { 'X-MCP-Credential-Mode': 'per_user' },
    ];
    for (const id of ['native', 'stdio'])
      for (const method of ['POST', 'GET', 'DELETE'])
        for (const extra of invalidHeaders) {
          const r = await fetch(`${url}/mcp/${id}`, {
            method,
            headers: {
              Authorization: `Bearer ${edge}`,
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              ...extra,
            },
            ...(method === 'POST'
              ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }
              : {}),
          });
          expect(r.status).toBe(400);
          expect(await r.json()).toEqual({
            error:
              extra['X-MCP-Credential-Mode'] === 'per_user'
                ? 'upstream_credential_required'
                : 'credential_mode_unsupported',
          });
          expect(bundle.active.has(id)).toBe(false);
        }
    expect(sharedSelections).toBe(0);
    for (const id of ['native', 'stdio'])
      for (const modern of [false, true]) {
        const c = await connect(url, id, 'per_user', modern);
        clients.push(c);
        const r = await c.callTool({ name: 'context_echo' });
        expect(JSON.parse((r.content[0] as { text: string }).text).digest).toBe(
          createHash('sha256').update('personal-synthetic').digest('hex'),
        );
      }
    expect(sharedSelections).toBe(0);
  } finally {
    for (const c of clients) await c.close();
    await bundle.close();
  }
});
