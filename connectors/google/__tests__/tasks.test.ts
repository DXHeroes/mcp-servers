import { afterEach, expect, it, vi } from 'vitest';
import { GoogleTasksServer } from '../src/tasks.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => vi.unstubAllGlobals());
function server(token = 'user-token') {
  return new GoogleTasksServer({ apiKey: token, headerName: 'Authorization', headerValue: token });
}
it('exposes all task operations and marks deletes and clear as destructive', async () => {
  const tools = await server().listTools();
  expect(tools.map((t) => t.name)).toEqual([
    'tasks_list_tasklists',
    'tasks_get_tasklist',
    'tasks_create_tasklist',
    'tasks_rename_tasklist',
    'tasks_delete_tasklist',
    'tasks_list_tasks',
    'tasks_get_task',
    'tasks_create_task',
    'tasks_update_task',
    'tasks_complete_task',
    'tasks_move_task',
    'tasks_delete_task',
    'tasks_clear_completed',
  ]);
  expect(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name)).toEqual([
    'tasks_list_tasklists',
    'tasks_get_tasklist',
    'tasks_list_tasks',
    'tasks_get_task',
  ]);
  for (const name of ['tasks_delete_tasklist', 'tasks_delete_task', 'tasks_clear_completed'])
    expect(tools.find((t) => t.name === name)?.annotations?.destructiveHint).toBe(true);
});
it('creates a task using only the user bearer and preserves pagination and due filters', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ id: 'created' }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const s = server();
  const result = await s.callTool('tasks_create_task', {
    tasklist: 'work',
    title: 'Water plants',
    due: '2026-11-07T00:00:00Z',
    parent: 'parent',
  });
  expect(result).toMatchObject({ structuredContent: { id: 'created' } });
  const [url, init] = fetch.mock.calls[0]!;
  expect(String(url)).toBe('https://tasks.googleapis.com/tasks/v1/lists/work/tasks?parent=parent');
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer user-token');
  expect(JSON.parse(init.body)).toEqual({ title: 'Water plants', due: '2026-11-07T00:00:00Z' });
  fetch.mockResolvedValue(new Response(JSON.stringify({ items: [], nextPageToken: 'next' })));
  expect(
    await s.callTool('tasks_list_tasks', {
      tasklist: 'work',
      pageToken: 'page',
      showHidden: true,
      showCompleted: false,
    }),
  ).toMatchObject({ structuredContent: { items: [], nextPageToken: 'next' } });
  expect(String(fetch.mock.calls[1]![0])).toContain('pageToken=page');
  expect(String(fetch.mock.calls[1]![0])).toContain('showCompleted=false');
});
it('refuses malformed inputs and dot path segments before any provider request', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const args of [
    { tasklist: '..' },
    { tasklist: 'a', maxResults: 101 },
    { tasklist: 'a', auth: 'secret' },
  ])
    expect(await server().callTool('tasks_list_tasks', args)).toMatchObject({ isError: true });
  expect(fetch).not.toHaveBeenCalled();
});
it('maps only 401 to the explicit credential signal and never reflects provider errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => new Response('user-token secret body', { status: 401 })),
  );
  await expect(server().callTool('tasks_list_tasklists', {})).rejects.toMatchObject({
    code: -32050,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => new Response('user-token secret body', { status: 403 })),
  );
  const result = await server().callTool('tasks_list_tasklists', {});
  expect(result).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'PROVIDER_ERROR', status: 403 } },
  });
  expect(JSON.stringify(result)).not.toContain('user-token');
});

it.each([
  ['tasks_get_tasklist', { tasklist: 'work' }, 'GET', 'users/@me/lists/work', undefined],
  ['tasks_create_tasklist', { title: 'Work' }, 'POST', 'users/@me/lists', { title: 'Work' }],
  [
    'tasks_rename_tasklist',
    { tasklist: 'work', title: 'New' },
    'PATCH',
    'users/@me/lists/work',
    { title: 'New' },
  ],
  ['tasks_delete_tasklist', { tasklist: 'work' }, 'DELETE', 'users/@me/lists/work', undefined],
  ['tasks_get_task', { tasklist: 'work', task: 'task' }, 'GET', 'lists/work/tasks/task', undefined],
  [
    'tasks_update_task',
    { tasklist: 'work', task: 'task', notes: '', due: null },
    'PATCH',
    'lists/work/tasks/task',
    { notes: '', due: null },
  ],
  [
    'tasks_complete_task',
    { tasklist: 'work', task: 'task' },
    'PATCH',
    'lists/work/tasks/task',
    { status: 'completed' },
  ],
  [
    'tasks_move_task',
    { tasklist: 'work', task: 'task', destinationTasklist: 'other' },
    'POST',
    'lists/work/tasks/task/move?destinationTasklist=other',
    undefined,
  ],
  [
    'tasks_delete_task',
    { tasklist: 'work', task: 'task' },
    'DELETE',
    'lists/work/tasks/task',
    undefined,
  ],
  ['tasks_clear_completed', { tasklist: 'work' }, 'POST', 'lists/work/clear', undefined],
] as const)(
  '%s sends the documented method, path and body',
  async (name, args, method, path, body) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    expect(await server().callTool(name, args)).toMatchObject({
      structuredContent: { success: true },
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`https://tasks.googleapis.com/tasks/v1/${path}`);
    expect(init.method).toBe(method);
    expect(init.body === undefined ? undefined : JSON.parse(init.body)).toEqual(body);
  },
);
it('does not retry an uncertain write and returns a long throttle without waiting', async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response('private', { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  expect(
    await server().callTool('tasks_create_task', { tasklist: 'a', title: 'New' }),
  ).toMatchObject({ isError: true });
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch
    .mockClear()
    .mockImplementation(
      async () => new Response('private', { status: 429, headers: { 'Retry-After': '60' } }),
    );
  expect(await server().callTool('tasks_list_tasklists', {})).toMatchObject({
    structuredContent: { error: { code: 'RATE_LIMITED', retryAfterMs: 60000 } },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('honors a cancelled call without sending a provider request', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  controller.abort();
  expect(
    await server().callTool('tasks_list_tasklists', {}, { signal: controller.signal }),
  ).toMatchObject({ isError: true });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ['tasks_list_tasklists', {}, 503],
  ['tasks_list_tasklists', {}, 429],
  ['tasks_create_task', { tasklist: 'a', title: 'New' }, 429],
] as const)(
  '%s retries a definite short refusal %s and then returns success',
  async (name, args, status) => {
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        async () => new Response('private', { status, headers: { 'Retry-After': '0' } }),
      )
      .mockImplementationOnce(async () => new Response(JSON.stringify({ id: 'ok' })));
    vi.stubGlobal('fetch', fetch);
    expect(await server().callTool(name, args)).toMatchObject({ structuredContent: { id: 'ok' } });
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);
it('bounds repeated read failures to three attempts', async () => {
  const fetch = vi
    .fn()
    .mockImplementation(
      async () => new Response('private', { status: 503, headers: { 'Retry-After': '0' } }),
    );
  vi.stubGlobal('fetch', fetch);
  expect(await server().callTool('tasks_list_tasklists', {})).toMatchObject({
    structuredContent: { error: { code: 'PROVIDER_ERROR', status: 503 } },
  });
  expect(fetch).toHaveBeenCalledTimes(3);
});
