import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(new URL('../packages/bundle/package.json', import.meta.url));
const { Client, StreamableHTTPClientTransport } = await import(
  require.resolve('@modelcontextprotocol/client')
);
const image = process.env.MCP_BUNDLE_IMAGE ?? 'mcp-task3c/bundle:test';
const name = `mcp-bundle-test-${randomUUID()}`;
const edge = 'fixture-edge-only';
const catalog = 'fixture-catalog-only';
const child = 'fixture-child-only';
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function until(check, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      return await check();
    } catch (e) {
      last = e;
      await delay(50);
    }
  }
  throw last;
}
const clients = [];
const fixtureDir = await mkdtemp(join(tmpdir(), 'bundle-image-regression-'));
try {
  await chmod(fixtureDir, 0o755);
  const manifest = JSON.parse(
    await readFile(new URL('../packages/bundle/fixtures/bundle.json', import.meta.url), 'utf8'),
  );
  for (const id of ['typescript', 'typescript-stdio']) {
    manifest.catalog.servers.find((s) => s.id === id).auth.credentialModes = ['per_user'];
    manifest.services.find((s) => s.id === id).sharedCredential = { env: 'TEST_DEPLOYMENT_SHARED' };
  }
  manifest.catalog.servers.push({
    id: 'broken',
    name: 'Broken stdin fixture',
    description: 'Isolated pipe failure regression',
    version: '1',
    endpoint: { transport: 'streamable-http', url: 'http://localhost:8080/mcp/broken' },
    auth: { type: 'none', credentialModes: ['shared'] },
  });
  manifest.services.push({
    id: 'broken',
    transport: 'stdio',
    argv: ['/usr/bin/python3', '/test/closed-stdin.py'],
    cwd: '/app',
    env: { PROBE_PID_FILE: '/tmp/broken-pids' },
    maxActive: 1,
  });
  await writeFile(join(fixtureDir, 'bundle.json'), JSON.stringify(manifest));
  await copyFile(
    new URL('../packages/bundle/__tests__/fixtures/closed-stdin.py', import.meta.url),
    join(fixtureDir, 'closed-stdin.py'),
  );
  docker(
    'run',
    '-d',
    '--name',
    name,
    '--user',
    '12345:12345',
    '--read-only',
    '--mount',
    `type=bind,src=${fixtureDir},dst=/test,readonly`,
    '-e',
    'MCP_BUNDLE_MANIFEST=/test/bundle.json',
    '-e',
    'TEST_DEPLOYMENT_SHARED=must-not-select-deployment-secret',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '128',
    '-p',
    '127.0.0.1::8080',
    '-e',
    `MCP_ACCESS_TOKEN=${edge}`,
    '-e',
    `MCP_CATALOG_ACCESS_TOKEN=${catalog}`,
    '-e',
    `BYZDATA_SERVICE_TOKEN=${child}`,
    '-e',
    'MCP_ALLOWED_HOSTS=127.0.0.1',
    '-e',
    'POSTGRES_SERVICE_TOKEN=fixture-postgres-only',
    '-e',
    'MCP_ALLOWED_ORIGINS=https://client.example',
    image,
  );
  const info = JSON.parse(docker('inspect', name))[0];
  const url = `http://127.0.0.1:${info.NetworkSettings.Ports['8080/tcp'][0].HostPort}`;
  const health = async () => {
    const r = await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${edge}` } });
    assert.equal(r.status, 200);
    return r.json();
  };
  await until(async () => {
    const h = await health();
    assert.equal(Object.values(h.services).filter((s) => s.status === 'ready').length, 5);
  });
  assert.equal(
    (await fetch(`${url}/catalog/v1/servers`, { headers: { Authorization: `Bearer ${edge}` } }))
      .status,
    401,
  );
  const catalogResponse = await fetch(`${url}/catalog/v1/servers`, {
    headers: { Authorization: `Bearer ${catalog}` },
  });
  assert.equal((await catalogResponse.json()).servers.length, 8);
  const connect = async (id, modern, secret = 'alpha') => {
    const c = new Client(
      { name: 'bundle-image-acceptance', version: '1' },
      modern ? { versionNegotiation: { mode: 'auto' } } : {},
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp/${id}`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${edge}`,
          ...(['byzdata', 'broken'].includes(id)
            ? {}
            : {
                'X-MCP-Credential-Mode': 'per_user',
                'X-MCP-Upstream-Credential': Buffer.from(secret).toString('base64url'),
              }),
        },
      },
    });
    await c.connect(transport);
    clients.push({ c, transport });
    return c;
  };
  for (const id of ['typescript', 'typescript-stdio'])
    for (const method of ['POST', 'GET', 'DELETE'])
      for (const mode of [undefined, 'shared', 'per_user']) {
        const response = await fetch(`${url}/mcp/${id}`, {
          method,
          headers: {
            Authorization: `Bearer ${edge}`,
            ...(mode ? { 'X-MCP-Credential-Mode': mode } : {}),
          },
        });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), {
          error:
            mode === 'per_user' ? 'upstream_credential_required' : 'credential_mode_unsupported',
        });
      }
  const broken = await connect('broken', false);
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(
      broken.listTools({}, { timeout: 2000 }),
      (error) => !/EPIPE|synthetic-private-child-diagnostic|closed-stdin.py/.test(String(error)),
    );
    await until(async () => {
      assert.equal((await health()).active.broken, 0);
      docker(
        'exec',
        name,
        'node',
        '-e',
        `const fs=require('fs');const pids=fs.readFileSync('/tmp/broken-pids','utf8').trim().split(String.fromCharCode(10));if(pids.length!==${attempt + 1}||pids.some(p=>fs.existsSync('/proc/'+p)))process.exit(1)`,
      );
    });
  }
  assert.equal(docker('logs', name), '');
  const text = (result) => result.content.find((x) => x.type === 'text').text;
  const results = [];
  for (const modern of [false, true]) {
    for (const id of [
      'typescript',
      'python',
      'express',
      'typescript-stdio',
      'python-stdio',
      'byzdata',
    ]) {
      const c = await connect(id, modern);
      assert.ok((await c.listTools()).tools.length);
      if (id !== 'byzdata') {
        const b = await connect(id, modern, 'beta');
        const values = await Promise.all([
          c.callTool({ name: 'context_echo' }),
          b.callTool({ name: 'context_echo' }),
        ]);
        assert.deepEqual(
          values.map((v) => JSON.parse(text(v)).digest),
          ['alpha', 'beta'].map((v) => createHash('sha256').update(v).digest('hex')),
        );
        assert.equal((await c.listResources()).resources[0].uri, 'fixture://status');
        assert.equal((await c.readResource({ uri: 'fixture://status' })).contents[0].text, 'ready');
        assert.equal((await c.listPrompts()).prompts[0].name, 'greet');
        assert.equal((await c.getPrompt({ name: 'greet' })).messages[0].role, 'user');
      } else assert.equal((await c.listResources()).resources.length, 3);
      results.push({ id, mode: modern ? 'auto' : 'legacy', passed: true });
    }
  }
  if (!process.env.POSTGRES_TEST_PASSWORD)
    throw new Error('POSTGRES_TEST_PASSWORD required for actual builtin acceptance');
  const pgCredential = `host=host.docker.internal port=${process.env.POSTGRES_TEST_PORT ?? '15434'} dbname=postgres user=${process.env.POSTGRES_TEST_USER ?? 'postgres'} password=${process.env.POSTGRES_TEST_PASSWORD} sslmode=disable`;
  for (const modern of [false, true]) {
    const c = await connect('postgres', modern, pgCredential);
    const tools = await c.listTools();
    const query = tools.tools.find((t) => /query/.test(t.name));
    assert.ok(query);
    const result = await c.callTool({
      name: query.name,
      arguments: { sql: 'SELECT 42 AS answer' },
    });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.match(text(result), /42/);
    results.push({ id: 'postgres', mode: modern ? 'auto' : 'legacy', passed: true });
  }
  for (const { c, transport } of clients.splice(0)) {
    await transport.terminateSession().catch(() => {});
    await c.close();
  }
  for (const id of ['typescript', 'python', 'express', 'typescript-stdio', 'python-stdio']) {
    const c = await connect(id, true);
    const abort = new AbortController();
    let progress = 0;
    const call = c.callTool(
      { name: 'context_echo', arguments: { wait: 500 } },
      { signal: abort.signal, onprogress: () => progress++ },
    );
    const rejected = assert.rejects(call);
    await until(() => assert.ok(progress > 0));
    abort.abort();
    await rejected;
    await c.close();
    await until(async () => {
      const h = await health();
      assert.equal(h.active[id], 0);
    });
  }
  const orphanPid = Number(
    docker(
      'exec',
      name,
      'node',
      '-e',
      `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},200)'],{stdio:'ignore',detached:true});console.log(c.pid);c.unref();`,
    ),
  );
  await until(() =>
    assert.equal(
      docker(
        'exec',
        name,
        'node',
        '-e',
        `console.log(require('fs').existsSync('/proc/${orphanPid}'))`,
      ),
      'false',
    ),
  );
  const processAudit = JSON.parse(
    docker(
      'exec',
      name,
      'node',
      '-e',
      `const fs=require('fs');const rows=fs.readdirSync('/proc').filter(x=>/^[0-9]+$/.test(x)).flatMap(pid=>{try{const s=fs.readFileSync('/proc/'+pid+'/status','utf8');return [{pid:+pid,command:fs.readFileSync('/proc/'+pid+'/cmdline','utf8'),state:s.match(/^State:\\s+(.*)$/m)[1],ppid:+s.match(/^PPid:\\s+(.*)$/m)[1]}]}catch{return []}});console.log(JSON.stringify(rows))`,
    ),
  );
  assert.ok(processAudit.length >= 7);
  assert.ok(processAudit.some((p) => p.pid === 1 && p.command.includes('tini')));
  assert.equal(processAudit.filter((p) => p.state.startsWith('Z')).length, 0);
  assert.equal(processAudit.filter((p) => p.command.includes('--stdio')).length, 0);
  assert.equal(
    docker(
      'exec',
      name,
      '/opt/venvs/python-fixture/bin/python',
      '-c',
      'import importlib.util; assert importlib.util.find_spec("pip") is None; print("no-runtime-pip")',
    ),
    'no-runtime-pip',
  );
  docker(
    'exec',
    name,
    'node',
    '-e',
    'const fs=require("fs");for(const p of ["/usr/local/bin/npm","/usr/local/bin/npx","/var/run/docker.sock"])if(fs.existsSync(p))process.exit(1)',
  );
  for (const { c, transport } of clients.splice(0)) {
    await transport.terminateSession().catch(() => {});
    await c.close();
  }
  docker('stop', '-t', '12', name);
  const ended = JSON.parse(docker('inspect', name))[0];
  assert.equal(ended.State.ExitCode, 0);
  console.log(
    JSON.stringify(
      {
        imageId: info.Image,
        architecture: docker('image', 'inspect', '--format', '{{.Architecture}}', image),
        user: info.Config.User,
        readOnly: info.HostConfig.ReadonlyRootfs,
        results,
        zeroZombies: true,
        cleanShutdown: true,
        brokenPipeFailuresIsolated: 3,
        unsupportedCredentialModeRequestsRejected: 18,
      },
      null,
      2,
    ),
  );
} finally {
  for (const { c } of clients) await c.close().catch(() => {});
  try {
    docker('rm', '-f', name);
  } catch {
    /* owned fixture only */
  }
  await rm(fixtureDir, { recursive: true, force: true });
}
