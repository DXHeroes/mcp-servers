import { afterEach, expect, it, vi } from 'vitest';
import { GraphClient } from '../src/index.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => vi.unstubAllGlobals());
it('limits service roots and pins its own bearer over configured header variants', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ value: [] }));
  vi.stubGlobal('fetch', fetch);
  const client = new GraphClient('user-token', {
    roots: ['chats', 'teams', 'users', 'me'],
    headers: { authorization: 'other', 'X-Fixed': 'value' },
  });
  await client.request('GET', 'chats/chat/messages');
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
    'Bearer user-token',
  );
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('x-fixed')).toBe('value');
  const scoped = new GraphClient('user-token');
  for (const path of ['teams/team/channels', 'meevil', 'https://evil.test/me'])
    await expect(scoped.request('GET', path)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('accepts only equivalent collection cursors, preserving encoded IDs without crossing collections', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ value: [] }));
  vi.stubGlobal('fetch', fetch);
  const client = new GraphClient('user-token', { roots: ['chats'] });
  await client.request(
    'GET',
    'chats/19%3Achat%40thread.v2/messages',
    {},
    undefined,
    'https://graph.microsoft.com/v1.0/me/chats/19:chat@thread.v2/messages?$skiptoken=next',
  );
  expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe(
    '/v1.0/chats/19%3Achat%40thread.v2/messages',
  );
  await expect(
    client.request(
      'GET',
      'chats/chat/messages',
      {},
      undefined,
      'https://graph.microsoft.com/v1.0/chats/other/messages',
    ),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
