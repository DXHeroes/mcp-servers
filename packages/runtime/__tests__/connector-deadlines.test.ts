import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpPackage } from '@dxheroes/mcp-kit';
import { expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));

const cases = [
  [
    'abra-flexi',
    'https://203.0.113.10/c/demo|fixture:synthetic',
    'flexi_delete_record',
    { evidence: 'adresar', id: 1 },
    'DELETE',
  ],
  ['fakturoid', 'fixture:client:synthetic', 'fakturoid_delete_subject', { id: 1 }, 'DELETE'],
  ['merk', 'synthetic', 'merk_subscription_info', {}, 'GET'],
] as const;

it.each(cases)(
  '%s bounds a stalled provider and dispatches the operation once',
  async (id, apiKey, tool, args, method) => {
    const { mcpPackage } = (await import(
      new URL(`../../../connectors/${id}/dist/index.js`, import.meta.url).href
    )) as { mcpPackage: McpPackage };
    const connector = mcpPackage.createServer({
      apiKey,
      headerName: 'Authorization',
      headerValue: apiKey,
    });
    let received!: (response: ServerResponse) => void;
    const pending = new Promise<ServerResponse>((resolve) => {
      received = resolve;
    });
    const methods: string[] = [];
    const upstream = createServer((req, res) => {
      if (req.url?.endsWith('/oauth/token')) {
        res.end(JSON.stringify({ access_token: 'fixture', expires_in: 3600 }));
        return;
      }
      methods.push(req.method!);
      received(res);
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const nativeFetch = globalThis.fetch;
    let observedSignal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      observedSignal = init.signal;
      return nativeFetch(base + new URL(url).pathname, init);
    });
    try {
      await connector.initialize();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const result = connector.callTool(tool, args);
      const response = await pending;
      await vi.advanceTimersByTimeAsync(20_000);
      // A late success must not turn an expired request into an acknowledged write.
      response.end('{}');
      const outcome = await result;
      expect(observedSignal?.aborted).toBe(true);
      expect(outcome).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining('UPSTREAM_TIMEOUT') }],
      });
      if (method === 'DELETE')
        expect(outcome).toMatchObject({
          content: [{ text: expect.stringContaining('Check the record before retrying') }],
        });
      expect(methods).toEqual([method]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await connector.close();
    }
  },
);
