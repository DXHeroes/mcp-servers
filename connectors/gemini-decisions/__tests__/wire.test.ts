import type { AddressInfo } from 'node:net';
import { createConnectorHttpServer, loadConfig } from '@dxheroes/mcp-runtime';
import { expect, it, vi } from 'vitest';
import { mcpPackage } from '../src/index.js';

it('lists and calls the connector through its real MCP HTTP transport and enforces the body limit', async () => {
  const config = await loadConfig({
    MCP_LOCAL_TEST_MODE: 'true',
    MCP_HOST: '127.0.0.1',
    MCP_UPSTREAM_CREDENTIAL: 'test-key',
  });
  const runtime = createConnectorHttpServer(mcpPackage, config);
  const httpFetch = globalThis.fetch;
  const usage = { total_input_tokens: 8, total_output_tokens: 0, total_tokens: 8 };
  const answers = { defect: { type: 'noul', noul: 0.97, confidence: 0.97 } };
  const google = vi.fn().mockImplementation(async () => Response.json({ answers, usage }));
  vi.stubGlobal('fetch', google);
  try {
    await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
    const port = (runtime.server.address() as AddressInfo).port;
    async function request(method: string, params: object) {
      return httpFetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
    }
    async function result(method: string, params: object) {
      const response = await request(method, params);
      expect(response.status).toBe(200);
      const wire = await response.text();
      const json = wire.startsWith('{')
        ? wire
        : wire
            .split('\n')
            .find((line) => line.startsWith('data:'))
            ?.slice(5);
      expect(json).toBeTruthy();
      return JSON.parse(json ?? '').result;
    }
    const listed = await result('tools/list', {});
    expect(listed.tools).toMatchObject([
      {
        name: 'gemini_decisions',
        inputSchema: {
          type: 'object',
          required: ['input', 'questions'],
          properties: { questions: { additionalProperties: { oneOf: expect.any(Array) } } },
        },
      },
    ]);
    const call = {
      name: 'gemini_decisions',
      arguments: {
        input: 'A chipped mug.',
        questions: { defect: { type: 'noul', instructions: 'Is the mug damaged?' } },
      },
    };
    const response = await result('tools/call', call);
    expect(response.structuredContent).toEqual({ answers, usage });
    expect(JSON.parse(response.content[0].text)).toEqual({ answers, usage });
    expect(
      (
        await request('tools/call', {
          ...call,
          arguments: { ...call.arguments, input: 'a'.repeat(config.maxBodyBytes) },
        })
      ).status,
    ).toBe(413);
    expect(google).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
    await runtime.close();
  }
});
