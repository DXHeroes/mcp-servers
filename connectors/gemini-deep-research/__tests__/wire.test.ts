import type { AddressInfo } from 'node:net';
import { createConnectorHttpServer, loadConfig } from '@dxheroes/mcp-runtime';
import { expect, it, vi } from 'vitest';
import { mcpPackage } from '../src/index.js';

it('chains a report and two follow-ups through standard MCP result fields', async () => {
  const runtime = createConnectorHttpServer(
    mcpPackage,
    await loadConfig({
      MCP_LOCAL_TEST_MODE: 'true',
      MCP_HOST: '127.0.0.1',
      MCP_UPSTREAM_CREDENTIAL: 'test-key',
    }),
  );
  const httpFetch = globalThis.fetch;
  const report = {
    id: 'report-id',
    agent: 'research',
    status: 'completed',
    outputs: [
      {
        type: 'text',
        text: 'Report',
        annotations: [{ type: 'url_citation', url: 'https://source.example/' }],
      },
    ],
  };
  const answer = {
    id: 'answer-id',
    model: 'gemini-flash-latest',
    status: 'completed',
    outputs: [{ type: 'text', text: 'Answer' }],
  };
  const responses = [
    { id: report.id, status: 'in_progress' },
    report,
    report,
    answer,
    answer,
    { ...answer, id: 'next-id' },
  ];
  const google = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = responses.shift();
    if (!response) throw new Error('Unexpected request');
    if (!responses.length)
      expect(await request.json()).toMatchObject({ previous_interaction_id: answer.id });
    return Response.json(response);
  });
  vi.stubGlobal('fetch', google);
  try {
    await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
    const port = (runtime.server.address() as AddressInfo).port;
    async function call(name: string, args: object) {
      const response = await httpFetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      expect(response.status).toBe(200);
      const wire = await response.text();
      const json = wire.startsWith('{')
        ? wire
        : wire
            .split('\n')
            .find((line) => line.startsWith('data:'))
            ?.slice(5);
      const result = JSON.parse(json ?? '').result;
      expect(result.isError).not.toBe(true);
      return result;
    }
    const initial = await call('deep_research', { topic: 'Research' });
    expect(initial.structuredContent).toEqual({
      interactionId: report.id,
      status: 'completed',
      citations: ['https://source.example/'],
    });
    expect(initial.content[0].text).toBe('Report');
    expect(initial.metadata).toEqual(initial.structuredContent);
    const follow = await call('deep_research_followup', {
      interactionId: initial.structuredContent.interactionId,
      question: 'Explain',
    });
    expect(follow.structuredContent).toEqual({ interactionId: answer.id, status: 'completed' });
    expect(follow.content[0].text).toBe('Answer');
    const { interactionId } = JSON.parse(follow.content[1].text);
    expect(interactionId).toBe(answer.id);
    const next = await call('deep_research_followup', { interactionId, question: 'Again' });
    expect(next.structuredContent.interactionId).toBe('next-id');
    expect(google).toHaveBeenCalledTimes(6);
  } finally {
    vi.unstubAllGlobals();
    await runtime.close();
  }
});
