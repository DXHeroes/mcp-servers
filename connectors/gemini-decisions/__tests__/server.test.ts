import { afterEach, expect, it, vi } from 'vitest';
import { mcpPackage } from '../src/index.js';

const creds = {
  apiKey: 'test-only-dummy',
  headerName: 'x-goog-api-key',
  headerValue: 'test-only-dummy',
};
const q = { type: 'noul', instructions: 'Does the mug have a chip?' };
const answer = { type: 'noul', noul: 0.99, confidence: 0.99 };
const usage = {
  total_input_tokens: 32,
  input_tokens_by_modality: [{ modality: 'text', tokens: 32 }],
  total_output_tokens: 0,
  total_tokens: 32,
};
const tool = 'gemini_decisions';
const args = { input: 'The mug has a chip.', questions: { chip: q } };
async function setup() {
  const server = await mcpPackage.createServer(creds);
  await server.initialize();
  return server;
}
afterEach(() => vi.unstubAllGlobals());
it('advertises exactly one tool and sends every modality and question type in one authorized POST', async () => {
  const questions = {
    chip: { ...q, criteria: { true_description: 'visible chip', false_description: 'intact' } },
    queue: {
      type: 'choice',
      instructions: { type: 'text', text: 'Which queue?' },
      criteria: { returns: '', other: '' },
    },
    damage: {
      type: 'score',
      instructions: [{ type: 'text', text: 'Rate damage.' }],
      criteria: ['none', 'some'],
    },
  };
  const input = [
    { type: 'text', text: '{"item":"mug"}' },
    { type: 'image', data: 'AQID', mime_type: 'image/jpeg', resolution: 'ultra_high' },
    {
      type: 'audio',
      uri: 'https://storage.googleapis.com/example/voice.wav',
      mime_type: 'audio/wav',
    },
    {
      type: 'video',
      uri: 'https://media.example/clip?signature=opaque',
      mime_type: 'video/mp4',
      resolution: 'low',
    },
    {
      type: 'document',
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/example',
      mime_type: 'application/pdf',
    },
  ];
  const answers = {
    chip: answer,
    queue: {
      type: 'choice',
      choice: 'returns',
      probabilities: { returns: 0.95, other: 0.05 },
      confidence: 0.95,
    },
    damage: {
      type: 'score',
      score: 0.9,
      probabilities: { 0: 0.1, 1: 0.9 },
      legend: { 0: 'none', 1: 'some' },
      confidence: 0.9,
    },
  };
  const fetcher = vi.fn().mockResolvedValue(Response.json({ answers, usage }));
  vi.stubGlobal('fetch', fetcher);
  const server = await setup();
  expect((await server.listTools()).map((t) => t.name)).toEqual([tool]);
  expect(await server.callTool(tool, { input, questions })).toMatchObject({
    structuredContent: { answers, usage },
    content: [{ type: 'text' }],
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/decisions');
  expect(init.method).toBe('POST');
  expect(new Headers(init.headers).get('x-goog-api-key')).toBe(creds.apiKey);
  expect(JSON.parse(init.body)).toEqual({ model: 'gemini-decision-1', input, questions });
});
it.each([1, 1000])('retains all %i named answers', async (count) => {
  const questions = Object.fromEntries(Array.from({ length: count }, (_, i) => [`q${i}`, q]));
  const answers = Object.fromEntries(Object.keys(questions).map((key) => [key, answer]));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ answers, usage })));
  expect(
    await (await setup()).callTool(tool, { input: { type: 'text', text: 'mug' }, questions }),
  ).toMatchObject({ structuredContent: { answers, usage } });
});
it.each([
  { input: '' },
  { input: [] },
  { input: { item: 'unspecified block' } },
  { input: { type: 'text', text: ' ' } },
  { questions: {} },
  { questions: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`q${i}`, q])) },
  { questions: { 'x y': q } },
  { questions: { bad: { ...q, instructions: { type: 'image', uri: 'https://example.org' } } } },
  { questions: { bad: { type: 'choice', instructions: '?', criteria: { x: '' } } } },
  {
    questions: { bad: { type: 'choice', instructions: '?', criteria: { 'bad ': '', other: '' } } },
  },
  { questions: { bad: { type: 'score', instructions: '?', criteria: ['ok', ' '] } } },
  { questions: { bad: { type: 'score', instructions: '?', criteria: Array(256).fill('x') } } },
  { input: { type: 'document', data: '???', mime_type: 'application/pdf' } },
  { input: { type: 'image', uri: 'file:///tmp/image', mime_type: 'image/png' } },
  {
    input: {
      type: 'image',
      data: 'AQID',
      uri: 'https://example.com/image',
      mime_type: 'image/png',
    },
  },
  { input: { type: 'video', uri: 'https://youtu.be/abc', mime_type: 'video/mp4' } },
  { input: { type: 'video', data: 'AQID', mime_type: 'video/mp4', resolution: 'ultra_high' } },
  { input: { type: 'audio', data: 'AQID', mime_type: 'video/mp4' } },
  { input: 'x'.repeat(2 * 1024 * 1024) },
])('rejects invalid request %# before fetching', async (overrides) => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect(await (await setup()).callTool(tool, { ...args, ...overrides })).toMatchObject({
    isError: true,
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([401, 403, 429, 504])(
  'redacts upstream HTTP %i errors and makes one call',
  async (status) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(creds.apiKey, { status }));
    vi.stubGlobal('fetch', fetcher);
    const result = await (await setup()).callTool(tool, args);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).not.toContain(creds.apiKey);
    expect(JSON.stringify(result)).toMatch(new RegExp(String(status)));
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it.each([
  {},
  { answers: {}, usage },
  { answers: { chip: { ...answer, noul: 12 } }, usage },
  { answers: { other: answer }, usage },
  { answers: { chip: answer }, usage: { total_tokens: -1 } },
])('rejects malformed provider payload %#', async (payload) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)));
  expect(await (await setup()).callTool(tool, args)).toMatchObject({ isError: true });
});
it('handles timeout without copying the remote error or retrying', async () => {
  const fetcher = vi.fn().mockRejectedValue(new DOMException(creds.apiKey, 'TimeoutError'));
  vi.stubGlobal('fetch', fetcher);
  const result = JSON.stringify(await (await setup()).callTool(tool, args));
  expect(result).toMatch(/timed out|timeout/i);
  expect(result).not.toContain(creds.apiKey);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejects malformed URL strings without throwing', async () => {
  const server = await setup();
  expect(
    await server.callTool(tool, {
      ...args,
      input: { type: 'image', mime_type: 'image/png', uri: 'broken URL' },
    }),
  ).toMatchObject({ isError: true });
});
it('preserves legal dictionary keys shared with Object.prototype', async () => {
  const criteria = Object.fromEntries([
    ['__proto__', ''],
    ['constructor', ''],
  ]);
  const questions = Object.fromEntries([
    ['__proto__', { type: 'choice', instructions: 'Where?', criteria }],
  ]);
  const answers = Object.fromEntries([
    [
      '__proto__',
      {
        type: 'choice',
        choice: '__proto__',
        probabilities: Object.fromEntries([
          ['__proto__', 1],
          ['constructor', 0],
        ]),
        confidence: 1,
      },
    ],
  ]);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ answers, usage })));
  expect(await (await setup()).callTool(tool, { input: 'item', questions })).toMatchObject({
    structuredContent: { answers, usage },
  });
});

it('rejects missing credentials, unknown tools and a pre-cancelled call before billing', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const missing = mcpPackage.createServer(null);
  await missing.initialize();
  expect(await missing.callTool(tool, args)).toMatchObject({ isError: true });
  expect(await missing.validate()).toMatchObject({ valid: false });
  const server = await setup();
  expect(await server.callTool('unknown', args)).toMatchObject({ isError: true });
  const cancelled = await server.callTool(tool, args, {
    signal: AbortSignal.abort(new Error(creds.apiKey)),
  });
  expect(JSON.stringify(cancelled)).toMatch(/cancelled/i);
  expect(JSON.stringify(cancelled)).not.toContain(creds.apiKey);
  expect(fetcher).not.toHaveBeenCalled();
});
it('rejects an unrequested choice even if its name exists on Object.prototype', async () => {
  const answers = {
    team: { type: 'choice', choice: 'toString', probabilities: { returns: 0.2, billing: 0.8 } },
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ answers, usage })));
  const questions = {
    team: { type: 'choice', instructions: 'Which team?', criteria: { returns: '', billing: '' } },
  };
  expect(await (await setup()).callTool(tool, { input: 'Mug.', questions })).toMatchObject({
    isError: true,
  });
});
it('rejects a score with a substituted level label', async () => {
  const answers = {
    severity: {
      type: 'score',
      score: 1,
      legend: { 0: 'none', 1: 'changed' },
      probabilities: { 0: 0, 1: 1 },
    },
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ answers, usage })));
  const questions = {
    severity: { type: 'score', instructions: 'How severe?', criteria: ['none', 'some'] },
  };
  expect(await (await setup()).callTool(tool, { input: 'Mug.', questions })).toMatchObject({
    isError: true,
  });
});
