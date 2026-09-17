import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { resolve } from 'node:path';
import type { RuntimeConfig } from '@dxheroes/mcp-runtime';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BundleManifest, parseBundle, type Service } from '../src/config.js';
import { createBundle } from '../src/router.js';

const config: RuntimeConfig & { catalogAccessToken: string } = {
  host: '127.0.0.1',
  port: 0,
  allowedHosts: ['127.0.0.1'],
  allowedOrigins: ['https://client.example'],
  accessToken: 'edge-only-synthetic',
  catalogAccessToken: 'catalog-only-synthetic',
  localTestMode: false,
  maxBodyBytes: 2 * 1024 * 1024,
  totalTimeoutMs: 10000,
  idleTimeoutMs: 3000,
};
const root = resolve(import.meta.dirname, '..');
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function port() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
function service(id: string, transport: 'http' | 'stdio', port?: number): Service {
  return {
    id,
    transport,
    port,
    argv: [
      process.execPath,
      resolve(root, 'dist/fixture.js'),
      ...(transport === 'stdio' ? ['--stdio'] : []),
    ],
    cwd: root,
    env: {},
    credentialModes: ['shared', 'per_user'],
    credentialChannel: true,
    maxActive: 8,
  };
}
function manifest(services: Service[]): BundleManifest {
  return {
    services,
    catalog: {
      schemaVersion: 1,
      servers: services.map((s) => ({
        id: s.id,
        name: s.id,
        version: '0.1.0',
        description: 'Test',
        endpoint: { transport: 'streamable-http', url: `http://127.0.0.1/mcp/${s.id}` },
        auth: {
          type: 'api_key',
          credentialDelivery: 'connector_base64url',
          credentialModes: [...s.credentialModes],
        },
      })),
    },
  };
}
async function start(services: Service[], overrides: Partial<typeof config> = {}) {
  const bundle = createBundle(manifest(services), { ...config, ...overrides });
  bundle.start();
  await new Promise<void>((r) => bundle.server.listen(0, '127.0.0.1', r));
  cleanup.push(() => bundle.close());
  const url = `http://127.0.0.1:${(bundle.server.address() as { port: number }).port}`;
  await vi.waitFor(
    () => {
      for (const s of services.filter((s) => s.transport === 'http' && s.id !== 'crash'))
        expect(bundle.supervisor.states.get(s.id)?.status).toBe('ready');
    },
    { timeout: 10000 },
  );
  return { bundle, url };
}
async function client(url: string, id: string, secret = 'alpha', modern = true) {
  const c = new Client(
    { name: 'test', version: '1' },
    modern ? { versionNegotiation: { mode: 'auto' } } : {},
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp/${id}`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'X-MCP-Credential-Mode': 'per_user',
        'X-MCP-Upstream-Credential': Buffer.from(secret).toString('base64url'),
      },
    },
  });
  await c.connect(transport);
  cleanup.push(async () => {
    await transport.terminateSession().catch(() => {});
    await c.close();
  });
  return c;
}
function content(result: Awaited<ReturnType<Client['callTool']>>) {
  const text = result.content.find((c) => c.type === 'text');
  return JSON.parse(text && 'text' in text ? text.text : '{}');
}
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
function dead(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

describe('trusted bundle real wire', () => {
  it('isolates concurrent native and stdio users in both eras, serves six MCP methods, reaps stdio', async () => {
    process.env.EDGE_SECRET = 'must-not-inherit';
    process.env.OTHER_SECRET = 'must-not-inherit';
    try {
      const { url, bundle } = await start([
        service('ts', 'http', await port()),
        service('stdio', 'stdio'),
      ]);
      for (const modern of [true, false])
        for (const id of ['ts', 'stdio']) {
          const a = await client(url, id, 'alpha', modern);
          const b = await client(url, id, 'beta', modern);
          expect((await a.listTools()).tools[0]?.name).toBe('context_echo');
          const results = await Promise.all([
            a.callTool({ name: 'context_echo' }),
            b.callTool({ name: 'context_echo' }),
          ]);
          expect(results.map((r) => content(r).digest)).toEqual([digest('alpha'), digest('beta')]);
          expect(results.map((r) => content(r).forbiddenEnv)).toEqual([false, false]);
          if (id === 'stdio') {
            expect(content(results[0]!).pid).not.toBe(content(results[1]!).pid);
            await vi.waitFor(() => {
              for (const r of results) expect(dead(content(r).pid)).toBe(true);
            });
          }
          expect((await a.listResources()).resources[0]?.uri).toBe('fixture://status');
          expect((await a.readResource({ uri: 'fixture://status' })).contents[0]).toMatchObject({
            text: 'ready',
          });
          expect((await a.listPrompts()).prompts[0]?.name).toBe('greet');
          expect((await a.getPrompt({ name: 'greet' })).messages[0]?.role).toBe('user');
        }
      await vi.waitFor(() => expect([...bundle.active.values()]).toEqual([0, 0]));
    } finally {
      delete process.env.EDGE_SECRET;
      delete process.env.OTHER_SECRET;
    }
  }, 30000);
  it('preserves legacy Express session, notification status, GET stream and DELETE', async () => {
    const s = service('express', 'http', await port());
    s.argv = [process.execPath, resolve(root, 'fixtures/express.mjs')];
    const { url } = await start([s]);
    const c = await client(url, 'express');
    expect(c.getServerVersion()?.name).toBe('express-fixture');
    expect(content(await c.callTool({ name: 'context_echo' })).digest).toBe(digest('alpha'));
    const response = await fetch(`${url}/mcp/express`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    });
    const session = response.headers.get('mcp-session-id')!;
    expect(session).toBeTruthy();
    await response.text();
    const headers = {
      Authorization: `Bearer ${config.accessToken}`,
      'mcp-session-id': session,
      'content-type': 'application/json',
    };
    expect(
      (
        await fetch(`${url}/mcp/express`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        })
      ).status,
    ).toBe(202);
    const abort = new AbortController();
    const stream = await fetch(`${url}/mcp/express`, { headers, signal: abort.signal });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    abort.abort();
    expect((await fetch(`${url}/mcp/express`, { method: 'DELETE', headers })).status).toBe(200);
  });
  it('streams progress before completion and disconnect releases stdio admission and process', async () => {
    const s = service('stdio', 'stdio');
    s.maxActive = 1;
    const { url, bundle } = await start([s]);
    const c = await client(url, 'stdio');
    let progress = 0;
    const abort = new AbortController();
    const running = c.callTool(
      { name: 'context_echo', arguments: { wait: 100 } },
      {
        signal: abort.signal,
        onprogress: () => {
          progress++;
        },
      },
    );
    const rejected = expect(running).rejects.toThrow();
    await vi.waitFor(() => expect(progress).toBeGreaterThan(0));
    expect(bundle.active.get('stdio')).toBe(1);
    const refused = await fetch(`${url}/mcp/stdio`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(refused.status).toBe(503);
    abort.abort();
    await rejected;
    await vi.waitFor(() => expect(bundle.active.get('stdio')).toBe(0), { timeout: 3000 });
    expect(content(await c.callTool({ name: 'context_echo' })).digest).toBe(digest('alpha'));
  });
  it('native streams progress without buffering and disconnects both modern and legacy calls', async () => {
    const { url, bundle } = await start([service('ts', 'http', await port())]);
    for (const modern of [true, false]) {
      const c = await client(url, 'ts', 'alpha', modern);
      let progress = 0;
      const abort = new AbortController();
      const running = c.callTool(
        { name: 'context_echo', arguments: { wait: 100 } },
        {
          signal: abort.signal,
          onprogress: () => {
            progress++;
          },
        },
      );
      const rejected = expect(running).rejects.toThrow();
      await vi.waitFor(() => expect(progress).toBeGreaterThan(0));
      abort.abort();
      await rejected;
      await c.close();
      await vi.waitFor(() => expect(bundle.active.get('ts')).toBe(0));
    }
  });
  it('validates outside Host/Origin and distinct auth before rewriting, never falls back for personal credentials', async () => {
    const { url } = await start([service('stdio', 'stdio')]);
    for (const headers of [
      { Authorization: 'Bearer wrong' },
      { Authorization: `Bearer ${config.accessToken}`, Origin: 'https://evil.example' },
      { Authorization: `Bearer ${config.accessToken}`, Host: 'evil.example' },
    ]) {
      const status = await new Promise<number>((resolve) => {
        const req = request(`${url}/mcp/stdio`, { method: 'POST', headers }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        });
        req.end('{}');
      });
      expect([401, 403]).toContain(status);
    }
    expect(
      (
        await fetch(`${url}/mcp/stdio`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            'X-MCP-Credential-Mode': 'per_user',
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${url}/catalog/v1/servers`, {
          headers: { Authorization: `Bearer ${config.accessToken}` },
        })
      ).status,
    ).toBe(401);
    const catalog = await fetch(`${url}/catalog/v1/servers`, {
      headers: { Authorization: `Bearer ${config.catalogAccessToken}` },
    });
    expect(catalog.status).toBe(200);
    expect((await catalog.json()).schemaVersion).toBe(1);
    expect(
      (
        await fetch(`${url}/mcp/stdio`, {
          headers: { Authorization: `Bearer ${config.catalogAccessToken}` },
        })
      ).status,
    ).toBe(401);
  });
  it('bounds crash loops independently and shuts down child processes', async () => {
    const crash = service('crash', 'http', await port());
    crash.argv = [process.execPath, '-e', 'process.exit(3)'];
    const { url, bundle } = await start([crash, service('healthy', 'http', await port())]);
    const c = await client(url, 'healthy');
    const pid = content(await c.callTool({ name: 'context_echo' })).pid;
    await vi.waitFor(
      () =>
        expect(bundle.supervisor.states.get('crash')).toEqual({ status: 'failed', restarts: 3 }),
      { timeout: 5000 },
    );
    const catalog = await fetch(`${url}/catalog/v1/servers`, {
      headers: { Authorization: `Bearer ${config.catalogAccessToken}` },
    });
    expect((await catalog.json()).servers).toHaveLength(2);
    await c.close();
    await bundle.close();
    expect(dead(pid)).toBe(true);
  });
  it('strips edge credentials and forwarding headers, uses distinct fixed child auth, refuses redirects', async () => {
    const s = service('headers', 'http', await port());
    s.childToken = 'child-only-synthetic';
    s.argv = [
      process.execPath,
      '-e',
      `const {createServer}=require('node:http');const {createHash}=require('node:crypto');createServer((req,res)=>{if(req.url==='/health')return res.end('ready');if(req.headers['x-test-redirect']){res.writeHead(307,{location:'http://127.0.0.1:1/leak'});return res.end();}res.setHeader('content-type','application/json');res.end(JSON.stringify({auth:createHash('sha256').update(req.headers.authorization||'').digest('hex'),upstream:req.headers['x-mcp-upstream-credential'],forwarded:req.headers.forwarded,cookie:req.headers.cookie,host:req.headers.host,origin:req.headers.origin}));}).listen(+process.env.MCP_PORT,'127.0.0.1')`,
    ];
    const { url } = await start([s]);
    const headers = {
      Authorization: `Bearer ${config.accessToken}`,
      Forwarded: 'host=evil',
      Cookie: 'private=secret',
      'X-MCP-Upstream-Credential': Buffer.from('alpha').toString('base64url'),
    };
    const response = await fetch(`${url}/mcp/headers`, { method: 'POST', headers, body: '{}' });
    expect(await response.json()).toEqual({
      auth: digest('Bearer child-only-synthetic'),
      upstream: Buffer.from('alpha').toString('base64url'),
      host: `127.0.0.1:${s.port}`,
      origin: 'http://127.0.0.1',
    });
    const redirect = await fetch(`${url}/mcp/headers`, {
      method: 'POST',
      headers: { ...headers, 'X-Test-Redirect': '1' },
      body: '{}',
    });
    expect(redirect.status).toBe(502);
    expect(redirect.headers.get('location')).toBeNull();
  });
  it('idle and hard deadlines release isolated stdio processes, including streaming calls', async () => {
    for (const hard of [false, true]) {
      const { url, bundle } = await start([service('stdio', 'stdio')], {
        idleTimeoutMs: hard ? 5000 : 400,
        totalTimeoutMs: hard ? 600 : 5000,
      });
      const c = await client(url, 'stdio');
      const running = c.callTool(
        { name: 'context_echo', arguments: { wait: 500 } },
        hard ? { onprogress: () => {}, timeout: 2500 } : { timeout: 2500 },
      );
      const rejected = expect(running).rejects.toThrow();
      await vi.waitFor(() => expect(bundle.active.get('stdio')).toBe(1));
      await vi.waitFor(() => expect(bundle.active.get('stdio')).toBe(0), { timeout: 2000 });
      await c.close();
      await rejected;
    }
  }, 10000);
  it('rejects incompatible auth, unsafe personal environment mapping, duplicate targets and edge token inheritance', async () => {
    const s = service('example', 'stdio');
    const doc = manifest([s]);
    const base = {
      catalog: doc.catalog,
      services: [
        {
          id: 'example',
          transport: 'stdio',
          argv: s.argv,
          cwd: root,
          env: {},
          requestCredentials: 'connector_base64url',
        },
      ],
    };
    expect(
      (await parseBundle(JSON.stringify(base), config.accessToken!)).services[0]?.credentialModes,
    ).toEqual(['shared', 'per_user']);
    for (const change of [
      { env: { NODE_OPTIONS: '--inspect' } },
      { requestCredentials: 'NODE_OPTIONS' },
      { childToken: { env: 'EDGE' } },
    ])
      await expect(
        parseBundle(
          JSON.stringify({ ...base, services: [{ ...base.services[0], ...change }] }),
          config.accessToken!,
          { EDGE: config.accessToken },
        ),
      ).rejects.toThrow('invalid_bundle_configuration');
    const targets = {
      catalog: {
        schemaVersion: 1,
        servers: [
          base.catalog.servers[0],
          {
            ...base.catalog.servers[0],
            id: 'second',
            endpoint: { transport: 'streamable-http', url: 'http://127.0.0.1/mcp/second' },
          },
        ],
      },
      services: [
        { ...base.services[0], transport: 'http', port: 21001 },
        { ...base.services[0], id: 'second', transport: 'http', port: 21002 },
      ],
    };
    expect((await parseBundle(JSON.stringify(targets), config.accessToken!)).services).toHaveLength(
      2,
    );
    const duplicatePort = structuredClone(targets);
    duplicatePort.services[1]!.port = duplicatePort.services[0]!.port;
    await expect(parseBundle(JSON.stringify(duplicatePort), config.accessToken!)).rejects.toThrow(
      'invalid_bundle_configuration',
    );
    const duplicateId = structuredClone(targets);
    duplicateId.services[1]!.id = duplicateId.services[0]!.id;
    await expect(parseBundle(JSON.stringify(duplicateId), config.accessToken!)).rejects.toThrow(
      'invalid_bundle_configuration',
    );
    const oauth = structuredClone(base);
    oauth.catalog.servers[0]!.auth = { type: 'oauth', credentialModes: ['shared'] };
    await expect(parseBundle(JSON.stringify(oauth), config.accessToken!)).rejects.toThrow();
  });
});
