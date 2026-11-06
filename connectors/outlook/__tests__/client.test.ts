import { afterEach, expect, it, vi } from 'vitest';
import { OutlookCalendarServer } from '../src/calendar.js';
import { OutlookMailServer } from '../src/mail.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const mail = () =>
  new OutlookMailServer({
    apiKey: 'account-token',
    headerName: 'Authorization',
    headerValue: 'account-token',
  });
it('honors an already cancelled explicit tool context before dispatch', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(
    await mail().callTool('mail_list_folders', {}, { signal: AbortSignal.abort() }),
  ).toHaveProperty('isError', true);
  expect(fetch).not.toHaveBeenCalled();
});
it('cancels a pending Graph request when its caller leaves', async () => {
  let ready!: () => void;
  const received = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const fetch = vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        ready();
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Cancelled', 'AbortError')),
          { once: true },
        );
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  const result = mail().callTool('mail_list_folders', {}, { signal: controller.signal });
  await received;
  controller.abort();
  expect(await result).toHaveProperty('isError', true);
});
it('retries Graph throttling for writes according to Retry-After, without replaying other failures', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response('secret', { status: 429, headers: { 'Retry-After': '0' } }))
    .mockResolvedValueOnce(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetch);
  expect(await mail().callTool('mail_send_draft', { messageId: 'draft' })).toMatchObject({
    structuredContent: { success: true },
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockReset().mockImplementation(async () => new Response('secret', { status: 503 }));
  expect(await mail().callTool('mail_send_draft', { messageId: 'draft' })).toMatchObject({
    structuredContent: { error: { status: 503 } },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('caps response bytes and does not expose provider body data when parsing fails', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))),
  );
  const result = await mail().callTool('mail_get_message', { messageId: 'm' });
  expect(result).toHaveProperty('isError', true);
  expect(JSON.stringify(result).length).toBeLessThan(250);
});
it('sends independent KQL and OData queries without changing caller text', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => new Response('{"value":[]}'));
  vi.stubGlobal('fetch', fetch);
  await mail().callTool('mail_search_messages', { search: 'subject:"Hello world"' });
  expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get('$search')).toBe(
    JSON.stringify('subject:"Hello world"'),
  );
  await mail().callTool('mail_search_messages', {
    filter: 'isRead eq false',
    orderBy: 'receivedDateTime desc',
  });
  expect(new URL(String(fetch.mock.calls[1]?.[0])).searchParams.get('$filter')).toBe(
    'isRead eq false',
  );
});
it('never returns a partial free/busy result for cyclic continuation', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('getSchedule')) return new Response(null, { status: 400 });
      if (path === '/v1.0/me') return new Response('{"mail":"me@example.test"}');
      return new Response(
        JSON.stringify({
          value: [],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?$skip=1',
        }),
      );
    }),
  );
  const calendar = new OutlookCalendarServer({
    apiKey: 'account-token',
    headerName: 'Authorization',
    headerValue: 'account-token',
  });
  expect(
    await calendar.callTool('calendar_get_free_busy', {
      startDateTime: '2026-11-06T00:00:00Z',
      endDateTime: '2026-11-07T00:00:00Z',
      schedules: ['me@example.test'],
    }),
  ).toHaveProperty('isError', true);
});
