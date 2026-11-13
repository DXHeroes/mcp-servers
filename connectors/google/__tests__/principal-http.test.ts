import { mkdtemp, rename, symlink, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeUpstreamContext } from '@dxheroes/mcp-kit';
import { createConnectorHttpServer, loadConfig, type RuntimeConfig } from '@dxheroes/mcp-runtime';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { endpoints, mcpPackage } from '../src/index.js';
import vectors from './fixtures/gateway-principal-v2.json';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
const realFetch = globalThis.fetch;
let registryFile: string;
let config: RuntimeConfig;
let registry: typeof vectors.registry;
let url: string;
let created: number;
let calls: { path: string; authorization: string }[];
const close: (() => Promise<unknown>)[] = [];
async function update(value: unknown) {
  const next = `${registryFile}.next`;
  await writeFile(next, JSON.stringify(value), { mode: 0o600 });
  await rename(next, registryFile);
}
async function start(overrides: Partial<RuntimeConfig> = {}) {
  const runtime = createConnectorHttpServer(
    mcpPackage,
    { ...config, ...overrides },
    endpoints.map((endpoint) => ({
      ...endpoint,
      package: {
        ...endpoint.package,
        createServer: (credential) => {
          created++;
          return endpoint.package.createServer(credential);
        },
      },
    })),
  );
  await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  close.push(() => runtime.close());
  return `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}`;
}
beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(vectors.now * 1000);
  created = 0;
  calls = [];
  registry = structuredClone(vectors.registry);
  registryFile = join(await mkdtemp(join(tmpdir(), 'principal-')), 'registry.json');
  await update(registry);
  config = await loadConfig({
    MCP_HOST: '127.0.0.1',
    MCP_PORT: '0',
    MCP_LOCAL_TEST_MODE: 'true',
    MCP_ACCESS_TOKEN: 'service-only',
    MCP_GOOGLE_PRINCIPAL_BINDING: JSON.stringify({
      registryFile,
      pairId: 'mail',
      readerPath: '/gmail-read/mcp',
      senderPath: '/gmail/mcp',
    }),
  });
  const provider = createServer(async (req, res) => {
    calls.push({ path: req.url!, authorization: req.headers.authorization ?? '' });
    for await (const _chunk of req) {
      /* drain only owned fixture requests */
    }
    const result = req.url!.endsWith('/profile')
      ? { emailAddress: 'robot@example.test' }
      : req.url!.endsWith('/messages/send')
        ? { id: 'fixture-sent', threadId: 'fixture-thread' }
        : { messages: [], resultSizeEstimate: 0 };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  close.push(() => new Promise<void>((resolve) => provider.close(() => resolve())));
  const port = (provider.address() as { port: number }).port;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.hostname === '127.0.0.1') return realFetch(input, init);
    expect(target.origin).toBe('https://gmail.googleapis.com');
    return realFetch(`http://127.0.0.1:${port}${target.pathname}${target.search}`, init);
  });
  url = await start();
});
afterEach(async () => {
  for (const cleanup of close.reverse()) await cleanup();
  close.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function headers(context: string | undefined, token = 'sender-token'): Record<string, string> {
  return {
    authorization: 'Bearer service-only',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-mcp-credential-mode': 'per_user',
    'x-mcp-upstream-credential': Buffer.from(token).toString('base64url'),
    ...(context === undefined ? {} : { 'x-mcp-upstream-context': context }),
  };
}
const send = {
  name: 'gmail_send_message',
  arguments: {
    from: 'robot@example.test',
    to: ['recipient@example.test'],
    subject: 'Synthetic test',
    text: 'Fixture only',
    messageId: '<fixture@example.test>',
  },
};
const read = { name: 'gmail_list_messages', arguments: {} };
async function call(
  context: string | undefined,
  token = 'sender-token',
  path = '/gmail/mcp',
  extra: Record<string, string> = {},
) {
  const response = await realFetch(`${url}${path}`, {
    method: 'POST',
    headers: { ...headers(context, token), ...extra },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: path === '/gmail-read/mcp' ? read : send,
    }),
  });
  return { status: response.status, text: await response.text() };
}
async function refused(context: string | undefined, token = 'sender-token', path = '/gmail/mcp') {
  const result = await call(context, token, path);
  expect(result.status).toBe(403);
  expect(JSON.parse(result.text)).toEqual({ error: 'google_principal_unavailable' });
  expect(calls).toHaveLength(0);
  expect(created).toBe(0);
  for (const secret of ['synthetic-subject', 'row-sender', '11111111', token, context].filter(
    Boolean,
  ))
    expect(result.text).not.toContain(secret);
}
it('actual frozen producer proof dispatches actual Google send and same-token reader profile', async () => {
  const sent = await call(vectors.headers.sender);
  expect(sent.status).toBe(200);
  expect(sent.text).toContain('fixture-sent');
  expect(calls).toEqual([
    { path: '/gmail/v1/users/me/messages/send', authorization: 'Bearer sender-token' },
  ]);
  calls = [];
  const readResult = await call(vectors.headers.reader, 'reader-token', '/gmail-read/mcp');
  expect(readResult.status).toBe(200);
  expect(readResult.text).toContain('robot@example.test');
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual({
    path: '/gmail/v1/users/me/profile',
    authorization: 'Bearer reader-token',
  });
  expect(calls.every((c) => c.authorization === 'Bearer reader-token')).toBe(true);
});
for (const [name, context] of Object.entries(vectors.negative))
  it(`zero provider dispatch: ${name}`, async () => refused(context));
for (const [name, context] of Object.entries({
  missing: undefined,
  v1: encodeUpstreamContext({ api_domain: 'https://api.example.test' }),
  malformed: '%%%bad',
  huge: 'A'.repeat(8193),
  json: Buffer.from('{}').toString('base64url'),
})) {
  it(`no downgrade: ${name}`, async () => refused(context));
}
it('mismatched actual token, wrong-purpose route and tampered signature refuse', async () => {
  await refused(vectors.headers.sender, 'foreign-token');
  await refused(vectors.headers.sender, 'sender-token', '/gmail-read/mcp');
  const envelope = JSON.parse(Buffer.from(vectors.headers.sender, 'base64url').toString());
  envelope.signature = 'A'.repeat(86);
  await refused(Buffer.from(JSON.stringify(envelope)).toString('base64url'));
});
it('service bearer alone never creates a connector', async () => {
  const response = await realFetch(`${url}/gmail/mcp`, {
    method: 'POST',
    headers: { authorization: 'Bearer service-only', 'content-type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(400);
  expect(await response.text()).toContain('per_user_required');
  expect(calls).toHaveLength(0);
  expect(created).toBe(0);
});
it('fresh atomic registry generation/reconnect update revokes old requests and admits new exact evidence', async () => {
  expect((await call(vectors.headers.sender)).status).toBe(200);
  calls = [];
  created = 0;
  registry.pairs[0]!.sender = vectors.newGeneration.pin;
  await update(registry);
  await refused(vectors.headers.sender);
  const fresh = await call(vectors.newGeneration.header, 'new-sender-token');
  expect(fresh.status).toBe(200);
  expect(calls[0]?.authorization).toBe('Bearer new-sender-token');
  calls = [];
  created = 0;
  await update({ version: 1, pairs: [] });
  await refused(vectors.newGeneration.header, 'new-sender-token');
});
it('no fallback across configured pairs or caller-controlled selectors', async () => {
  const other = structuredClone(registry.pairs[0]!);
  other.id = 'other';
  other.sender = vectors.alternate.pin;
  other.reader.subject = other.sender.subject;
  other.reader.email = other.sender.email;
  registry.pairs.push(other);
  await update(registry);
  const result = await call(vectors.alternate.header, 'sender-token', '/gmail/mcp', {
    'x-pair-id': 'other',
  });
  expect(result.status).toBe(403);
  expect(calls).toHaveLength(0);
  expect(created).toBe(0);
});
for (const mutation of [
  'subject',
  'email',
  'row',
  'grant',
  'purpose',
  'unknown',
  'duplicate',
  'invalid-key',
] as const) {
  it(`pair registry refusal: ${mutation}`, async () => {
    const pair = registry.pairs[0]!;
    if (mutation === 'subject') pair.reader.subject = 'foreign';
    if (mutation === 'email') pair.reader.email = 'foreign@example.test';
    if (mutation === 'row') pair.reader.credentialId = pair.sender.credentialId;
    if (mutation === 'grant') pair.reader.grantId = pair.sender.grantId;
    if (mutation === 'purpose') pair.reader.purpose = 'gmail_send';
    if (mutation === 'duplicate') registry.pairs.push(structuredClone(pair));
    if (mutation === 'invalid-key') pair.reader.publicKey = 'invalid';
    await update(mutation === 'unknown' ? { ...registry, enrolledByCaller: true } : registry);
    await refused(vectors.headers.sender);
  });
}
it('same-runtime-owned registry is refused in production, without changing host ownership', async () => {
  url = await start({ localTestMode: false });
  await refused(vectors.headers.sender);
});
it('symlink, oversized, invalid UTF8 and unsafe-mode registry refuse', async () => {
  const link = `${registryFile}.link`;
  await symlink(registryFile, link);
  url = await start({
    googlePrincipalBinding: { ...config.googlePrincipalBinding!, registryFile: link },
  });
  await refused(vectors.headers.sender);
  url = await start();
  await writeFile(registryFile, Buffer.alloc(65537, 65));
  await refused(vectors.headers.sender);
  await writeFile(registryFile, Buffer.from([0xff]));
  await refused(vectors.headers.sender);
  const unsafe = `${registryFile}.unsafe`;
  // Test-owned file only; mode is supplied at creation, never a host chmod.
  await writeFile(unsafe, JSON.stringify(registry), { mode: 0o666 });
  // umask may mask writes, so enforce an unsafe owned fixture using its descriptor.
  const { open } = await import('node:fs/promises');
  const descriptor = await open(unsafe, 'r+');
  try {
    await descriptor.chmod(0o666);
  } finally {
    await descriptor.close();
  }
  url = await start({
    googlePrincipalBinding: { ...config.googlePrincipalBinding!, registryFile: unsafe },
  });
  await refused(vectors.headers.sender);
});
it('parallel valid and foreign requests keep tokens and verification state isolated', async () => {
  const results = await Promise.all(
    Array.from({ length: 18 }, (_, i) =>
      i % 3 === 0
        ? call(vectors.headers.sender)
        : i % 3 === 1
          ? call(vectors.headers.reader, 'reader-token', '/gmail-read/mcp')
          : call(vectors.negative.foreignSubject),
    ),
  );
  expect(results.filter((r) => r.status === 403)).toHaveLength(6);
  expect(results.filter((r) => r.status === 200)).toHaveLength(12);
  expect(created).toBe(12);
  expect(calls).toHaveLength(18);
  expect(
    calls
      .filter((c) => c.path.endsWith('/messages/send'))
      .every((c) => c.authorization === 'Bearer sender-token'),
  ).toBe(true);
  expect(
    calls
      .filter((c) => !c.path.endsWith('/messages/send'))
      .every((c) => c.authorization === 'Bearer reader-token'),
  ).toBe(true);
});
it('legacy unbound Google stays compatible', async () => {
  url = await start({ googlePrincipalBinding: undefined });
  expect((await call(undefined)).status).toBe(200);
  expect(calls).toHaveLength(1);
});
it('unknown bindings, wrong routes and non-loopback test override fail startup', async () => {
  await expect(
    loadConfig({
      MCP_HOST: '127.0.0.1',
      MCP_LOCAL_TEST_MODE: 'true',
      MCP_GOOGLE_PRINCIPAL_BINDING: JSON.stringify({
        ...config.googlePrincipalBinding,
        unknown: true,
      }),
    }),
  ).rejects.toThrow('Invalid Google principal configuration');
  expect(() =>
    createConnectorHttpServer(
      mcpPackage,
      {
        ...config,
        googlePrincipalBinding: { ...config.googlePrincipalBinding!, senderPath: '/tasks/mcp' },
      },
      endpoints,
    ),
  ).toThrow('Invalid Google principal configuration');
  expect(() =>
    createConnectorHttpServer(mcpPackage, { ...config, host: '0.0.0.0' }, endpoints),
  ).toThrow('Local test mode');
});
it('duplicate proof headers refuse before provider dispatch', async () => {
  const result = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(
      `${url}/gmail/mcp`,
      {
        method: 'POST',
        headers: {
          ...headers(undefined),
          'x-mcp-upstream-context': [vectors.headers.sender, vectors.headers.sender],
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, text }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: send }));
  });
  expect(result.status).toBe(400);
  expect(result.text).toContain('invalid_headers');
  expect(calls).toHaveLength(0);
  expect(created).toBe(0);
});
