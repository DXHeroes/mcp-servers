import { afterEach, expect, it, vi } from 'vitest';
import { classifyGeminiError } from '../src/errors.js';
import { GeminiClient } from '../src/gemini-client.js';

function mockGemini(...responses: Array<Response | ((request: Request) => Promise<Response>)>) {
  const requests: Request[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    const response = responses.shift();
    if (!response) throw new Error('Unexpected Gemini request');
    return typeof response === 'function' ? response(request) : response;
  });
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('starts stored background research and returns report text and citations from interaction steps', async () => {
  const requests = mockGemini(
    Response.json({ id: 'research-id', status: 'in_progress', steps: [] }),
    Response.json({
      id: 'research-id',
      status: 'completed',
      steps: [
        {
          type: 'user_input',
          content: [{ type: 'text', text: 'Synthetic research topic' }],
        },
        {
          type: 'model_output',
          content: [
            {
              type: 'text',
              text: 'First section. ',
              annotations: [{ type: 'url_citation', url: 'https://source.example/article' }],
            },
            {
              type: 'text',
              text: 'Second section.',
              annotations: [
                { type: 'url_citation', url: 'https://source.example/article' },
                { type: 'file_citation', document_uri: 'https://source.example/document.pdf' },
              ],
            },
          ],
        },
      ],
    }),
  );
  const result = await new GeminiClient('fixture-key').deepResearch({
    topic: 'Synthetic research topic',
  });

  expect.soft(result).toEqual({
    content: 'First section. Second section.',
    interactionId: 'research-id',
    citations: ['https://source.example/article', 'https://source.example/document.pdf'],
    status: 'completed',
  });
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ['POST', '/v1beta/interactions'],
    ['GET', '/v1beta/interactions/research-id'],
  ]);
  expect.soft(await requests[0]?.json()).toEqual({
    agent: 'deep-research-preview-04-2026',
    input: 'Synthetic research topic',
    background: true,
    store: true,
  });
  expect(requests.map((request) => request.headers.get('api-revision'))).toEqual([
    '2026-05-20',
    '2026-05-20',
  ]);
});

it('answers a follow-up linked to an existing interaction with Gemini 3.8 Flash', async () => {
  const requests = mockGemini(
    Response.json({
      id: 'followup-id',
      status: 'completed',
      steps: [
        {
          type: 'model_output',
          content: [{ type: 'text', text: 'Synthetic follow-up answer.' }],
        },
      ],
    }),
  );

  const result = await new GeminiClient('fixture-key').followUp(
    'stored-id',
    'Explain the first section.',
  );

  expect(result).toEqual({
    content: 'Synthetic follow-up answer.',
    interactionId: 'followup-id',
    status: 'completed',
  });
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ['POST', '/v1beta/interactions'],
  ]);
  expect.soft(await requests[0]?.json()).toEqual({
    model: 'gemini-3.8-flash',
    input: 'Explain the first section.',
    previous_interaction_id: 'stored-id',
  });
  expect(requests[0]?.headers.get('api-revision')).toBe('2026-05-20');
});

it('surfaces a provider rate limit without retrying a billable follow-up', async () => {
  const requests = mockGemini(
    Response.json(
      { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Fixture quota exceeded' } },
      { status: 429 },
    ),
    Response.json({ id: 'duplicate', status: 'completed', steps: [] }),
  );

  const result = new GeminiClient('fixture-key').followUp(
    'stored-id',
    'Explain the first section.',
  );
  await expect.soft(result.catch(classifyGeminiError)).resolves.toMatchObject({
    code: 'RATE_LIMITED',
    status: 429,
  });
  expect(requests).toHaveLength(1);
});

it('reports a follow-up that requires continuation without submitting another paid request', async () => {
  const requests = mockGemini(
    Response.json({
      id: 'followup-id',
      status: 'requires_continuation',
      continuation_token: 'fixture-token',
      steps: [
        {
          type: 'model_output',
          content: [{ type: 'text', text: 'Partial answer.' }],
        },
      ],
    }),
    Response.json({ id: 'continuation-id', status: 'completed', steps: [] }),
  );

  await expect
    .soft(new GeminiClient('fixture-key').followUp('stored-id', 'Explain the first section.'))
    .rejects.toMatchObject({
      code: 'API_ERROR',
      message: 'Gemini follow-up did not complete.',
    });
  expect(requests).toHaveLength(1);
});

it('reads an older interaction completed with legacy outputs', async () => {
  mockGemini(
    Response.json({ id: 'legacy-id', status: 'in_progress' }),
    Response.json({
      id: 'legacy-id',
      status: 'completed',
      outputs: [
        { type: 'text', text: 'Earlier draft' },
        {
          type: 'text',
          text: 'Final legacy report',
          annotations: [{ type: 'url_citation', url: 'https://source.example/legacy' }],
        },
      ],
    }),
  );

  await expect(new GeminiClient('fixture-key').deepResearch({ topic: 'Fixture' })).resolves.toEqual(
    {
      content: 'Final legacy report',
      interactionId: 'legacy-id',
      citations: ['https://source.example/legacy'],
      status: 'completed',
    },
  );
});

it.each(['incomplete', 'requires_continuation', 'budget_exceeded'])(
  'ends research when the API reports %s',
  async (status) => {
    const requests = mockGemini(
      Response.json({ id: 'research-id', status: 'in_progress', steps: [] }),
      Response.json({ id: 'research-id', status, steps: [] }),
    );

    await expect(
      new GeminiClient('fixture-key').deepResearch(
        { topic: 'Fixture' },
        {
          signal: new AbortController().signal,
          onProgress: async () => {
            throw new Error('Unexpected poll after research ended');
          },
        },
      ),
    ).resolves.toMatchObject({ interactionId: 'research-id', status: 'failed' });
    expect(requests).toHaveLength(2);
  },
);

it('preserves the timeout and cancels upstream when the deadline aborts an active poll', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let markPollStarted!: () => void;
  const pollStarted = new Promise<void>((resolve) => {
    markPollStarted = resolve;
  });
  const requests = mockGemini(
    Response.json({ id: 'research-id', status: 'in_progress', steps: [] }),
    (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), {
          once: true,
        });
        markPollStarted();
      }),
    Response.json({ id: 'research-id', status: 'cancelled', steps: [] }),
  );

  const result = new GeminiClient('fixture-key').deepResearch({ topic: 'Fixture' });
  const rejection = result.catch(classifyGeminiError);
  await pollStarted;
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

  await expect.soft(rejection).resolves.toMatchObject({ code: 'TIMEOUT' });
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ['POST', '/v1beta/interactions'],
    ['GET', '/v1beta/interactions/research-id'],
    ['POST', '/v1beta/interactions/research-id/cancel'],
  ]);
  expect(requests[1]?.signal.aborted).toBe(true);
  expect(requests[2]?.signal.aborted).toBe(false);
  expect(requests[2]?.headers.get('api-revision')).toBe('2026-05-20');
});
