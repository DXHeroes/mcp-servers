import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type ApiKeyConfig,
  type McpPackage,
  McpServer,
  type ToolCallContext,
} from '@dxheroes/mcp-kit';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig, type RuntimeConfig } from '../src/config.js';
import { createConnectorHttpServer } from '../src/http.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const config: RuntimeConfig = {
  host: '127.0.0.1',
  port: 0,
  allowedHosts: ['127.0.0.1'],
  allowedOrigins: ['https://client.example'],
  accessToken: 'test-transport-only',
  sharedCredential: 'shared-test',
  localTestMode: false,
  maxBodyBytes: 2048,
  totalTimeoutMs: 3000,
  idleTimeoutMs: 1000,
};
let created = 0,
  closed = 0,
  active = 0;
class Fixture extends McpServer {
  constructor(private credential: ApiKeyConfig | null) {
    super();
    created++;
  }
  async initialize() {}
  async close() {
    await delay(5);
    closed++;
  }
  async listTools() {
    return [
      {
        name: 'echo',
        description: 'Context digest',
        inputSchema: z.object({
          nullable: z.number().nullable().optional(),
          wait: z.number().default(0),
        }),
        outputSchema: { type: 'array', items: { type: 'string' } },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
    ];
  }
  async callTool(_name: string, args: unknown, context?: ToolCallContext) {
    active++;
    try {
      const wait = (args as { wait?: number }).wait ?? 0;
      for (let i = 0; i < wait; i++) {
        await delay(15, undefined, { signal: context?.signal });
        if (!(args as { silent?: boolean }).silent) await context?.onProgress?.();
      }
      return {
        content: [{ type: 'text', text: 'unchanged' }],
        structuredContent: [digest(this.credential?.apiKey ?? 'none')],
      };
    } finally {
      active--;
    }
  }
  async listResources() {
    return [{ uri: 'fixture://value', name: 'fixture' }];
  }
  async readResource(uri: string) {
    return { contents: [{ uri, text: 'literal', mimeType: 'text/plain' }] };
  }
  async listPrompts() {
    return [{ name: 'greet', description: 'greet', arguments: [{ name: 'who', required: true }] }];
  }
  async getPrompt(_name: string, args?: Record<string, string>) {
    return {
      messages: [
        { role: 'user' as const, content: { type: 'text' as const, text: args?.who ?? 'none' } },
      ],
    };
  }
}
const pkg: McpPackage = {
  metadata: {
    id: 'fixture',
    name: 'Fixture',
    version: '0.1.0',
    description: 'test',
    requiresApiKey: true,
  },
  createServer: (c) => new Fixture(c),
};
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.reverse()) await close();
  cleanups.length = 0;
});
async function start(overrides: Partial<RuntimeConfig> = {}) {
  const runtime = createConnectorHttpServer(pkg, { ...config, ...overrides });
  await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => runtime.close());
  return new URL(`http://127.0.0.1:${(runtime.server.address() as { port: number }).port}/mcp`);
}
async function client(
  url: URL,
  mode: 'auto' | 'legacy',
  credential?: string,
  credentialMode?: string,
) {
  const headers = {
    Authorization: `Bearer ${config.accessToken}`,
    ...(credential !== undefined
      ? { 'X-MCP-Upstream-Credential': Buffer.from(credential).toString('base64url') }
      : {}),
    ...(credentialMode ? { 'X-MCP-Credential-Mode': credentialMode } : {}),
  };
  const c = new Client(
    { name: 'test', version: '1.0.0' },
    mode === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {},
  );
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  await c.connect(transport);
  cleanups.push(() => c.close());
  return c;
}
for (const era of ['auto', 'legacy'] as const)
  describe(era, () => {
    it('serves normalized schemas, projected results, resources, prompts and isolated concurrent credentials', async () => {
      const url = await start();
      const a = await client(url, era, 'personal-á', 'per_user'),
        b = await client(url, era, 'personal-b', 'per_user'),
        shared = await client(url, era);
      const list = await a.listTools();
      expect(list.tools[0]?.inputSchema.properties?.nullable).toMatchObject({
        anyOf: [{ type: 'number' }, { type: 'null' }],
      });
      expect(list.tools[0]?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
      const results = await Promise.all([
        a.callTool({ name: 'echo', arguments: { wait: 2 } }),
        b.callTool({ name: 'echo' }),
        shared.callTool({ name: 'echo' }),
      ]);
      for (const [i, secret] of ['personal-á', 'personal-b', 'shared-test'].entries())
        expect(results[i]?.structuredContent).toEqual(
          era === 'legacy' ? { result: [digest(secret)] } : [digest(secret)],
        );
      expect((await a.listResources()).resources[0]?.uri).toBe('fixture://value');
      expect(await a.readResource({ uri: 'fixture://value' })).toMatchObject({
        contents: [{ uri: 'fixture://value', text: 'literal', mimeType: 'text/plain' }],
      });
      expect((await a.listPrompts()).prompts).toHaveLength(1);
      expect(
        (await a.getPrompt({ name: 'greet', arguments: { who: 'Alice' } })).messages[0]?.content,
      ).toEqual({ type: 'text', text: 'Alice' });
      expect(transportSecrets(results)).toBe(false);
      await vi.waitFor(() => expect(closed).toBe(created));
    });
    it('cancels an exclusively owned client transport and drains the real operation', async () => {
      const url = await start();
      const c = await client(url, era);
      let progressed!: () => void;
      const began = new Promise<void>((resolve) => {
        progressed = resolve;
      });
      const call = c.callTool(
        { name: 'echo', arguments: { wait: 100 } },
        { onprogress: () => progressed() },
      );
      const rejected = expect(call).rejects.toThrow();
      await began;
      await c.close();
      await rejected;
      await vi.waitFor(() => {
        expect(active).toBe(0);
        expect(closed).toBe(created);
      });
    });
    it('enforces idle timeout when a call emits no progress', async () => {
      const url = await start({ totalTimeoutMs: 2000, idleTimeoutMs: 60 });
      const c = await client(url, era);
      await expect(
        c.callTool({ name: 'echo', arguments: { wait: 100, silent: true } }),
      ).rejects.toThrow();
      await vi.waitFor(() => {
        expect(active).toBe(0);
        expect(closed).toBe(created);
      });
    });
    it('emits progress, independently enforces total deadline and drains cancellation', async () => {
      const url = await start({ totalTimeoutMs: 180, idleTimeoutMs: 90 });
      const c = await client(url, era);
      let progress = 0;
      await expect(
        c.callTool(
          { name: 'echo', arguments: { wait: 100 } },
          {
            onprogress: () => {
              progress++;
            },
            timeout: 1000,
            resetTimeoutOnProgress: true,
          },
        ),
      ).rejects.toThrow();
      expect(progress).toBeGreaterThan(0);
      await vi.waitFor(() => {
        expect(active).toBe(0);
        expect(closed).toBe(created);
      });
    });
  });
function transportSecrets(value: unknown) {
  return JSON.stringify(value).includes(config.accessToken!);
}
it('rejects unauthorized requests, malformed credentials, absent personal secret and duplicate reserved headers', async () => {
  const url = await start();
  for (const [headers, status] of [
    [{}, 401],
    [{ Authorization: 'Bearer wrong' }, 401],
    [{ Authorization: `Bearer ${config.accessToken}`, 'X-MCP-Credential-Mode': 'per_user' }, 400],
    [{ Authorization: `Bearer ${config.accessToken}`, 'X-MCP-Credential-Mode': 'invalid' }, 400],
    ...['YQ=', 'YQ==', 'YQ, Yg', '_w', 'Zh', ''].map((value) => [
      { Authorization: `Bearer ${config.accessToken}`, 'X-MCP-Upstream-Credential': value },
      400,
    ]),
    [{ Authorization: `Bearer ${config.accessToken}`, Origin: 'https://evil.example' }, 403],
  ] as [Record<string, string>, number][]) {
    const result = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(result.status).toBe(status);
    expect(await result.text()).not.toContain('test-');
  }
  const status = await new Promise<number>((resolve) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          'X-MCP-Credential-Mode': ['shared', 'per_user'],
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.end('{}');
  });
  expect(status).toBe(400);
  const wrongHost = await new Promise<number>((resolve) => {
    const req = request(
      url,
      { headers: { Host: 'evil.example', Authorization: `Bearer ${config.accessToken}` } },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.end();
  });
  expect(wrongHost).toBe(403);
  expect(
    (
      await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ data: 'x'.repeat(3000) }),
      })
    ).status,
  ).toBe(413);
});
it('requires explicit authentication and prevents publicly bound test mode', async () => {
  await expect(loadConfig({})).rejects.toThrow();
  await expect(loadConfig({ MCP_LOCAL_TEST_MODE: 'true' })).rejects.toThrow();
  await expect(
    loadConfig({ MCP_LOCAL_TEST_MODE: 'true', MCP_HOST: '127.0.0.1' }),
  ).resolves.toMatchObject({ localTestMode: true });
});
