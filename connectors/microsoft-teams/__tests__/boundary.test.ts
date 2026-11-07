import { setTimeout as nativeTimer } from 'node:timers';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MicrosoftTeamsServer } from '../src/index.js';

const dns = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: dns }));
beforeEach(() => dns.mockReset().mockResolvedValue([{ address: '203.0.113.10', family: 4 }]));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const server = () =>
  new MicrosoftTeamsServer({
    apiKey: 'work-token',
    headerName: 'Authorization',
    headerValue: 'work-token',
  });
const message = { chatId: 'chat', body: { contentType: 'text', content: 'Hello' } };
function stalledDns() {
  let ready!: () => void;
  let release!: () => void;
  const received = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  dns.mockImplementation(async () => {
    ready();
    await released;
    return [{ address: '203.0.113.10', family: 4 }];
  });
  return { received, release };
}
it('never follows provider redirects with a user token', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://other.example/path' } }),
    )
    .mockResolvedValueOnce(Response.json({ value: [] }));
  vi.stubGlobal('fetch', fetch);
  expect(await server().callTool('teams_list_chats', {})).toHaveProperty('isError', true);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('cancels DNS preparation promptly and prevents later HTTP dispatch', async () => {
  const gate = stalledDns();
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ value: [] }));
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  const pending = server().callTool('teams_list_chats', {}, { signal: controller.signal });
  await gate.received;
  controller.abort();
  let outcome: unknown;
  try {
    outcome = await Promise.race([
      pending.then(() => 'done'),
      new Promise((resolve) => nativeTimer(() => resolve('pending'), 50)),
    ]);
  } finally {
    gate.release();
    await pending;
  }
  expect(outcome).toBe('done');
  expect(fetch).not.toHaveBeenCalled();
});
it('bounds a stalled lookup by twenty seconds without changing long-running tools', async () => {
  vi.useFakeTimers();
  const gate = stalledDns();
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ value: [] }));
  vi.stubGlobal('fetch', fetch);
  const pending = server().callTool('teams_list_chats', {});
  await gate.received;
  await vi.advanceTimersByTimeAsync(20001);
  let outcome: unknown;
  try {
    outcome = await Promise.race([
      pending.then(() => 'done'),
      new Promise((resolve) => nativeTimer(() => resolve('pending'), 50)),
    ]);
  } finally {
    gate.release();
    await pending;
  }
  expect(outcome).toBe('done');
  expect(fetch).not.toHaveBeenCalled();
});
it('checks monotonic expiry after DNS when timer execution is delayed', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const gate = stalledDns();
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ value: [] }));
  vi.stubGlobal('fetch', fetch);
  const pending = server().callTool('teams_list_chats', {});
  await gate.received;
  clock.mockReturnValue(30000);
  gate.release();
  expect(await pending).toHaveProperty('isError', true);
  expect(fetch).not.toHaveBeenCalled();
});
it('retries definite write throttling and never replays uncertain write failures', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '0' } }))
    .mockResolvedValueOnce(Response.json({ id: 'sent' }));
  vi.stubGlobal('fetch', fetch);
  expect(await server().callTool('teams_send_chat_message', message)).toMatchObject({
    structuredContent: { id: 'sent' },
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockReset().mockImplementation(async () => new Response('private', { status: 503 }));
  expect(await server().callTool('teams_send_chat_message', message)).toMatchObject({
    isError: true,
    structuredContent: { error: { status: 503 } },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockReset().mockRejectedValue(new Error('uncertain private outcome'));
  expect(await server().callTool('teams_send_chat_message', message)).toHaveProperty(
    'isError',
    true,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('returns a long Retry-After instead of waiting beyond the interactive budget', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 429, headers: { 'Retry-After': '60' } })),
  );
  expect(await server().callTool('teams_send_chat_message', message)).toMatchObject({
    isError: true,
    structuredContent: {
      error: { code: 'RATE_LIMITED', status: 429, retryAfterMs: expect.any(Number) },
    },
  });
});
it('bounds provider JSON without exposing response content', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('private'.repeat(400000))),
  );
  const result = await server().callTool('teams_list_chats', {});
  expect(result).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'UPSTREAM_UNAVAILABLE' } },
  });
  expect(JSON.stringify(result).length).toBeLessThan(250);
});
