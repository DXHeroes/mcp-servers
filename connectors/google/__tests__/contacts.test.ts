import { afterEach, expect, it, vi } from 'vitest';
import * as google from '../src/index.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const credential = (token = 'contact-user') => ({
  apiKey: token,
  headerName: 'Authorization',
  headerValue: token,
});
function server(token = 'contact-user') {
  expect(google.GoogleContactsServer).toBeTypeOf('function');
  return new google.GoogleContactsServer(credential(token));
}
const source = { id: '123', etag: 'source-etag' };
it('separates contact and Workspace-only directory offers from Tasks', () => {
  expect(google.endpoints.map((e) => [e.path, e.package.metadata.id, e.auth])).toEqual([
    ['/tasks/mcp', 'google-tasks', 'oauth'],
    ['/contacts/mcp', 'google-contacts', 'oauth'],
    ['/directory/mcp', 'google-directory', 'oauth'],
    ['/gmail/mcp', 'google-gmail-send', 'oauth'],
  ]);
  expect(google.contactsPackage.metadata.oauthDefaults?.scopes).toEqual([
    'https://www.googleapis.com/auth/contacts',
  ]);
  expect(google.directoryPackage.metadata.oauthDefaults?.scopes).toEqual([
    'https://www.googleapis.com/auth/directory.readonly',
  ]);
});
it('exposes seven complete contact operations and keeps directory search off the contact route', async () => {
  const tools = await server().listTools();
  expect(tools.map((t) => t.name)).toEqual([
    'contacts_search',
    'contacts_get',
    'contacts_list_groups',
    'contacts_create',
    'contacts_update',
    'contacts_delete',
    'contacts_add_to_group',
  ]);
  expect(tools.filter((t) => t.annotations?.readOnlyHint)).toHaveLength(3);
  expect(tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name)).toEqual([
    'contacts_delete',
  ]);
  expect(
    (await new google.GoogleDirectoryServer(credential()).listTools()).map((t) => t.name),
  ).toEqual(['directory_search']);
  expect(await server().callTool('directory_search', { query: 'A' })).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'UNKNOWN_TOOL' } },
  });
});
it('warms only the current user cache before the actual prefix search', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(
      Response.json({
        results: [{ person: { resourceName: 'people/c123', names: [{ displayName: 'Alex' }] } }],
      }),
    );
  vi.stubGlobal('fetch', fetch);
  const result = await server().callTool('contacts_search', {
    query: 'Alex',
    pageSize: 25,
    fields: ['names', 'emailAddresses'],
  });
  expect(result).toMatchObject({
    structuredContent: { results: [{ person: { resourceName: 'people/c123' } }] },
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  const [first, second] = fetch.mock.calls.map(([u]) => new URL(String(u)));
  expect(first!.origin + first!.pathname).toBe(
    'https://people.googleapis.com/v1/people:searchContacts',
  );
  expect(Object.fromEntries(first!.searchParams)).toMatchObject({
    query: '',
    readMask: 'names,emailAddresses,metadata',
    pageSize: '1',
  });
  expect(Object.fromEntries(second!.searchParams)).toMatchObject({
    query: 'Alex',
    readMask: 'names,emailAddresses,metadata',
    pageSize: '25',
  });
  for (const [, init] of fetch.mock.calls)
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer contact-user');
});
it.each([
  [
    'contacts_get',
    { resourceName: 'people/c123', fields: ['names'] },
    'GET',
    'people/c123',
    { personFields: 'names,metadata', sources: 'READ_SOURCE_TYPE_CONTACT' },
    undefined,
  ],
  [
    'contacts_list_groups',
    { pageToken: 'opaque/+=', pageSize: 100 },
    'GET',
    'contactGroups',
    { pageToken: 'opaque/+=', pageSize: '100' },
    undefined,
  ],
  [
    'contacts_create',
    {
      person: {
        names: [{ givenName: 'Alex', familyName: 'Fixture' }],
        emailAddresses: [{ value: 'alex@example.test', type: 'work' }],
      },
    },
    'POST',
    'people:createContact',
    undefined,
    {
      names: [{ givenName: 'Alex', familyName: 'Fixture' }],
      emailAddresses: [{ value: 'alex@example.test', type: 'work' }],
    },
  ],
  [
    'contacts_update',
    {
      resourceName: 'people/c123',
      source,
      person: { emailAddresses: [], names: [{ givenName: 'New' }] },
    },
    'PATCH',
    'people/c123:updateContact',
    { updatePersonFields: 'names,emailAddresses' },
    {
      resourceName: 'people/c123',
      metadata: { sources: [{ type: 'CONTACT', id: '123', etag: 'source-etag' }] },
      names: [{ givenName: 'New' }],
      emailAddresses: [],
    },
  ],
  [
    'contacts_delete',
    { resourceName: 'people/c123' },
    'DELETE',
    'people/c123:deleteContact',
    undefined,
    undefined,
  ],
  [
    'contacts_add_to_group',
    { resourceName: 'people/c123', groupResourceName: 'contactGroups/starred' },
    'POST',
    'contactGroups/starred/members:modify',
    undefined,
    { resourceNamesToAdd: ['people/c123'] },
  ],
] as const)(
  '%s sends the documented resource, fields and source version',
  async (name, args, method, path, query, body) => {
    const response = {
      resourceName: 'people/c123',
      contactGroups: [],
      nextPageToken: 'next/+=',
      metadata: { sources: [{ type: 'CONTACT', id: '123', etag: 'new-etag' }] },
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(response));
    vi.stubGlobal('fetch', fetch);
    expect(await server().callTool(name, args)).toMatchObject({ structuredContent: response });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe(`https://people.googleapis.com/v1/${path}`);
    expect(init?.method).toBe(method);
    if (query)
      for (const [key, value] of Object.entries(query)) {
        if (key === 'updatePersonFields')
          expect(parsed.searchParams.get(key)?.split(',').sort()).toEqual([
            'emailAddresses',
            'names',
          ]);
        else expect(parsed.searchParams.get(key)).toBe(value);
      }
    expect(init?.body ? JSON.parse(String(init.body)) : undefined).toEqual(body);
  },
);
it('requires a contact-source etag and explicitly supplied replacement fields before updates', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const args of [
    { resourceName: 'people/c123', person: { names: [{ givenName: 'No source' }] } },
    {
      resourceName: 'people/c123',
      source: { id: '123' },
      person: { names: [{ givenName: 'No etag' }] },
    },
    { resourceName: 'people/c123', source, person: {} },
    { resourceName: 'people/c123', source, person: { names: undefined } },
    { resourceName: 'people/c123', source, person: { memberships: undefined } },
    { resourceName: 'people/me', source, person: { names: [{ givenName: 'Profile write' }] } },
    { resourceName: 'people/c123', source, person: { memberships: [] } },
    { resourceName: 'people/c123', source, person: { metadata: { sources: [] }, names: [{}] } },
    { resourceName: 'people/c123', source, person: { names: [{}, {}] } },
  ])
    expect(await server().callTool('contacts_update', args)).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'INVALID_ARGUMENTS' } },
    });
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects unsafe resource names, invalid masks, oversize payloads and unsupported search pagination', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const [name, args] of [
    ['contacts_get', { resourceName: 'people/../admin' }],
    ['contacts_delete', { resourceName: 'people/%2e%2e' }],
    ['contacts_get', { resourceName: 'people/c123', fields: ['*'] }],
    ['contacts_search', { query: 'Alex', pageToken: 'unsupported' }],
    ['contacts_search', { query: '', pageSize: 31 }],
    ['contacts_list_groups', { pageSize: 1001 }],
    [
      'contacts_add_to_group',
      { resourceName: 'people/c123', groupResourceName: 'https://other.example/group' },
    ],
    ['contacts_create', { person: { names: [{ givenName: 'x'.repeat(66000) }] } }],
    ['contacts_create', { person: { names: [] } }],
  ] as const)
    expect(await server().callTool(name, args)).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'INVALID_ARGUMENTS' } },
    });
  expect(fetch).not.toHaveBeenCalled();
});
it('does not reread and overwrite a changed contact or replay uncertain writes', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response('private-provider-conflict', { status: 400 }),
  );
  vi.stubGlobal('fetch', fetch);
  const result = await server().callTool('contacts_update', {
    resourceName: 'people/c123',
    source,
    person: { names: [{ givenName: 'Fixture' }] },
  });
  expect(result).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'PROVIDER_ERROR', status: 400 } },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain('private-');
  fetch
    .mockClear()
    .mockImplementation(async () => new Response('private-outcome', { status: 503 }));
  expect(
    await server().callTool('contacts_create', { person: { names: [{ givenName: 'Fixture' }] } }),
  ).toHaveProperty('isError', true);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('reports a definite missing group member even when Google returns HTTP 200', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ notFoundResourceNames: ['people/c123'] }));
  expect(
    await server().callTool('contacts_add_to_group', {
      resourceName: 'people/c123',
      groupResourceName: 'contactGroups/starred',
    }),
  ).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONTACT_NOT_FOUND' } } });
});
it('searches the Workspace directory only on its own route with repeated source parameters', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ people: [{ resourceName: 'people/123' }], nextPageToken: 'next' }),
  );
  vi.stubGlobal('fetch', fetch);
  const directory = new google.GoogleDirectoryServer(credential());
  expect(
    await directory.callTool('directory_search', {
      query: 'Alex',
      pageToken: 'page=',
      pageSize: 50,
      fields: ['names'],
    }),
  ).toMatchObject({
    structuredContent: { people: [{ resourceName: 'people/123' }], nextPageToken: 'next' },
  });
  const url = new URL(String(fetch.mock.calls[0]![0]));
  expect(url.origin + url.pathname).toBe(
    'https://people.googleapis.com/v1/people:searchDirectoryPeople',
  );
  expect(url.searchParams.getAll('sources')).toEqual([
    'DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT',
    'DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE',
  ]);
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    query: 'Alex',
    pageToken: 'page=',
    pageSize: '50',
    readMask: 'names,metadata',
  });
  expect(await directory.callTool('contacts_create', { person: { names: [{}] } })).toHaveProperty(
    'isError',
    true,
  );
});
it('keeps directory denials and provider credential rejection distinct', async () => {
  vi.stubGlobal('fetch', async () => new Response('private-denial', { status: 403 }));
  expect(
    await new google.GoogleDirectoryServer(credential()).callTool('directory_search', {
      query: 'Alex',
    }),
  ).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'PROVIDER_ERROR', status: 403 } },
  });
  vi.stubGlobal('fetch', async () => new Response('private-revoked', { status: 401 }));
  await expect(
    server().callTool('contacts_get', { resourceName: 'people/c123' }),
  ).rejects.toMatchObject({ code: -32050 });
});
it('serializes same-user mutations across server instances while other users proceed', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent: string[] = [];
  vi.stubGlobal('fetch', async (_: string, init?: RequestInit) => {
    const token = new Headers(init?.headers).get('authorization')!;
    sent.push(token);
    if (sent.length === 1) {
      entered();
      await gate;
    }
    return Response.json({ resourceName: 'people/c123' });
  });
  const args = { person: { names: [{ givenName: 'Fixture' }] } };
  const first = server('same-user').callTool('contacts_create', args);
  await started;
  const second = server('same-user').callTool('contacts_create', args);
  const other = server('other-user').callTool('contacts_create', args);
  await other;
  expect(sent).toEqual(['Bearer same-user', 'Bearer other-user']);
  release();
  await Promise.all([first, second]);
  expect(sent).toEqual(['Bearer same-user', 'Bearer other-user', 'Bearer same-user']);
});
it('abandons a cancelled queued write and lets the next user mutation proceed', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    if (fetch.mock.calls.length === 1) {
      entered();
      await gate;
    }
    return Response.json({ resourceName: 'people/c123' });
  });
  vi.stubGlobal('fetch', fetch);
  const args = { person: { names: [{ givenName: 'Fixture' }] } };
  const first = server('queued-user').callTool('contacts_create', args);
  await started;
  const controller = new AbortController();
  const cancelled = server('queued-user').callTool('contacts_create', args, {
    signal: controller.signal,
  });
  controller.abort();
  expect(await cancelled).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'UPSTREAM_UNAVAILABLE' } },
  });
  release();
  await first;
  expect(await server('queued-user').callTool('contacts_create', args)).toMatchObject({
    structuredContent: { resourceName: 'people/c123' },
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('supports every mutable People field without accepting read-only top-level fields', async () => {
  const person = {
    addresses: [{ city: 'Prague' }],
    biographies: [{ value: 'Fixture', contentType: 'TEXT_PLAIN' }],
    birthdays: [{ date: { month: 5, day: 1 } }],
    calendarUrls: [{ url: 'https://calendar.example.test' }],
    clientData: [{ key: 'fixture', value: '1' }],
    emailAddresses: [{ value: 'fixture@example.test' }],
    events: [{ date: { month: 6, day: 2 }, type: 'anniversary' }],
    externalIds: [{ value: 'fixture' }],
    genders: [{ value: 'unspecified' }],
    imClients: [{ username: 'fixture' }],
    interests: [{ value: 'Gardening' }],
    locales: [{ value: 'cs' }],
    locations: [{ value: 'Prague' }],
    memberships: [
      { contactGroupMembership: { contactGroupResourceName: 'contactGroups/myContacts' } },
    ],
    miscKeywords: [{ value: 'fixture', type: 'OUTLOOK_KEYWORD' }],
    names: [{ givenName: 'Fixture' }],
    nicknames: [{ value: 'Fixture' }],
    occupations: [{ value: 'Tester' }],
    organizations: [{ name: 'Fixture' }],
    phoneNumbers: [{ value: '+420123456789' }],
    relations: [{ person: 'Other fixture', type: 'friend' }],
    sipAddresses: [{ value: 'fixture@example.test' }],
    urls: [{ value: 'https://example.test' }],
    userDefined: [{ key: 'fixture', value: '1' }],
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ resourceName: 'people/c123' }),
  );
  vi.stubGlobal('fetch', fetch);
  expect(
    await server().callTool('contacts_update', { resourceName: 'people/c123', source, person }),
  ).toHaveProperty('structuredContent');
  const [url, init] = fetch.mock.calls[0]!;
  expect(new URL(String(url)).searchParams.get('updatePersonFields')?.split(',').sort()).toEqual(
    [
      'addresses',
      'biographies',
      'birthdays',
      'calendarUrls',
      'clientData',
      'emailAddresses',
      'events',
      'externalIds',
      'genders',
      'imClients',
      'interests',
      'locales',
      'locations',
      'memberships',
      'miscKeywords',
      'names',
      'nicknames',
      'occupations',
      'organizations',
      'phoneNumbers',
      'relations',
      'sipAddresses',
      'urls',
      'userDefined',
    ].sort(),
  );
  expect(JSON.parse(String(init?.body))).toMatchObject(person);
  expect(
    await server().callTool('contacts_create', {
      person: { photos: [{ url: 'https://example.test' }] },
    }),
  ).toHaveProperty('isError', true);
});
