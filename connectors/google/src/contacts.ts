/** People API contacts and a separate Workspace directory offer. OAuth stays in the gateway. */
import { createHash } from 'node:crypto';
import {
  type ApiKeyConfig,
  checkToolCallDeadline,
  McpServer,
  type McpTool,
  type ToolCallContext,
  withToolCallDeadline,
} from '@dxheroes/mcp-kit';
import { UpstreamCredentialInvalidError } from '@dxheroes/mcp-runtime';
import { z } from 'zod';
import { GoogleApiError, GoogleClient } from './client.js';

const writableFields = [
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
] as const;
const readableFields = [
  ...writableFields,
  'ageRanges',
  'coverPhotos',
  'metadata',
  'photos',
  'skills',
] as const;
const singleton = new Set<string>(['biographies', 'birthdays', 'genders', 'names']);
const fieldObject = z.record(z.string().min(1).max(100), z.json());
const person = z
  .object(
    Object.fromEntries(
      writableFields.map((field) => [
        field,
        z
          .array(fieldObject)
          .max(singleton.has(field) ? 1 : 100)
          .optional(),
      ]),
    ),
  )
  .strict();
const fields = z
  .array(z.enum(readableFields))
  .min(1)
  .max(readableFields.length)
  .refine((v) => new Set(v).size === v.length)
  .optional();
const resourceName = z.string().regex(/^people\/[A-Za-z0-9_-]{1,256}$/);
const contactResource = resourceName.refine(
  (v) => v !== 'people/me',
  'A contact resource is required',
);
const source = z
  .object({ id: z.string().min(1).max(1024), etag: z.string().min(1).max(4096) })
  .strict();
const groupResourceName = z.string().regex(/^contactGroups\/[A-Za-z0-9_-]{1,256}$/);
const pageToken = z.string().min(1).max(8192).optional();
const defaultFields = 'names,emailAddresses,phoneNumbers,memberships,metadata';
type Args = Record<string, unknown>;
function mask(fields: unknown): string {
  return fields
    ? Array.from(new Set([...(fields as string[]), 'metadata'])).join(',')
    : defaultFields;
}
function supplied(p: unknown): p is Args {
  return !!p && Object.keys(p as Args).length > 0 && Object.values(p as Args).every(Array.isArray);
}
function bounded(input: unknown): boolean {
  try {
    if (Buffer.byteLength(JSON.stringify(input ?? {}), 'utf8') > 64 * 1024) return false;
    const pending: [unknown, number][] = [[input, 0]];
    while (pending.length) {
      const [value, depth] = pending.pop()!;
      if (depth > 10) return false;
      if (value && typeof value === 'object')
        for (const child of Object.values(value)) pending.push([child, depth + 1]);
    }
    return true;
  } catch {
    return false;
  }
}
// Process-local serialization is a provider recommendation, not a cross-replica lock.
const mutationTails = new Map<string, Promise<void>>();
async function serialMutation<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = mutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(
    () => slot,
    () => slot,
  );
  mutationTails.set(key, tail);
  try {
    await previous.catch(() => {});
    checkToolCallDeadline();
    return await run();
  } finally {
    release();
    if (mutationTails.get(key) === tail) mutationTails.delete(key);
  }
}
interface Operation {
  name: string;
  description: string;
  schema: z.ZodType;
  read?: boolean;
  destructive?: boolean;
  run: (client: GoogleClient, args: Args) => Promise<Record<string, unknown>>;
}
const contactOperations: Operation[] = [
  {
    name: 'contacts_search',
    description:
      'Search contact prefix matches, at most 30 results. Warms this user cache first; both requests share one deadline. No page token is supported by this API.',
    schema: z
      .object({
        query: z.string().trim().min(1).max(1024),
        pageSize: z.number().int().min(1).max(30).default(10),
        fields,
      })
      .strict(),
    read: true,
    run: async (c, a) => {
      const query = { readMask: mask(a.fields), sources: ['READ_SOURCE_TYPE_CONTACT'] };
      await c.request('GET', 'people:searchContacts', { ...query, query: '', pageSize: 1 });
      return c.request('GET', 'people:searchContacts', {
        ...query,
        query: a.query,
        pageSize: a.pageSize,
      });
    },
  },
  {
    name: 'contacts_get',
    description:
      'Get contact-only person data, including source etags for a later update. Profiles and directory data are not merged.',
    schema: z.object({ resourceName, fields }).strict(),
    read: true,
    run: (c, a) =>
      c.request('GET', String(a.resourceName), {
        personFields: mask(a.fields),
        sources: ['READ_SOURCE_TYPE_CONTACT'],
      }),
  },
  {
    name: 'contacts_list_groups',
    description:
      'List one page of the user contact groups. Members are not populated; preserve nextPageToken.',
    schema: z
      .object({ pageToken, pageSize: z.number().int().min(1).max(1000).default(100) })
      .strict(),
    read: true,
    run: (c, a) =>
      c.request('GET', 'contactGroups', { pageToken: a.pageToken, pageSize: a.pageSize }),
  },
  {
    name: 'contacts_create',
    description:
      'Create a contact from native People API field arrays. Singleton fields allow one entry. Provider validates individual field values.',
    schema: z
      .object({
        person: person.refine(
          (p) => supplied(p) && Object.values(p).some((v) => Array.isArray(v) && v.length > 0),
          'Supply contact data',
        ),
        fields,
      })
      .strict(),
    run: (c, a) =>
      c.request(
        'POST',
        'people:createContact',
        { personFields: mask(a.fields), sources: ['READ_SOURCE_TYPE_CONTACT'] },
        a.person,
      ),
  },
  {
    name: 'contacts_update',
    description:
      'Replace only supplied contact field arrays; [] clears a field. Requires the CONTACT source id and etag from a prior read. A conflict is not automatically reread or overwritten.',
    schema: z
      .object({
        resourceName: contactResource,
        source,
        person: person.refine(
          (p) => supplied(p) && (!('memberships' in p) || (p.memberships as unknown[]).length > 0),
          'Supply fields; memberships must not be empty',
        ),
        fields,
      })
      .strict(),
    run: (c, a) =>
      c.request(
        'PATCH',
        `${a.resourceName}:updateContact`,
        {
          updatePersonFields: Object.keys(a.person as Args).join(','),
          personFields: mask(a.fields),
          sources: ['READ_SOURCE_TYPE_CONTACT'],
        },
        {
          resourceName: a.resourceName,
          metadata: { sources: [{ type: 'CONTACT', ...(a.source as Args) }] },
          ...(a.person as Args),
        },
      ),
  },
  {
    name: 'contacts_delete',
    description:
      'Permanently delete contact data only; non-contact profile data is preserved by Google. This API has no source-etag parameter.',
    schema: z.object({ resourceName: contactResource }).strict(),
    destructive: true,
    run: (c, a) => c.request('DELETE', `${a.resourceName}:deleteContact`, {}),
  },
  {
    name: 'contacts_add_to_group',
    description:
      'Add one contact to a user group, myContacts or starred. Other system groups may reject additions. A missing person is an error even at HTTP 200.',
    schema: z.object({ resourceName: contactResource, groupResourceName }).strict(),
    run: (c, a) =>
      c.request(
        'POST',
        `${a.groupResourceName}/members:modify`,
        {},
        { resourceNamesToAdd: [a.resourceName] },
      ),
  },
];
const directoryOperations: Operation[] = [
  {
    name: 'directory_search',
    description:
      'Search the connected Workspace user domain directory. Requires directory.readonly and administrator-enabled directory sharing; personal accounts have no domain directory. Returns one page.',
    schema: z
      .object({
        query: z.string().trim().min(1).max(1024),
        fields,
        pageToken,
        pageSize: z.number().int().min(1).max(500).default(100),
      })
      .strict(),
    read: true,
    run: (c, a) =>
      c.request('GET', 'people:searchDirectoryPeople', {
        query: a.query,
        readMask: mask(a.fields),
        sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT', 'DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
        pageToken: a.pageToken,
        pageSize: a.pageSize,
      }),
  },
];
class PeopleServer extends McpServer {
  private readonly client: GoogleClient | null;
  private readonly mutationKey: string;
  constructor(
    credential: ApiKeyConfig | null,
    private readonly operations: readonly Operation[],
  ) {
    super();
    this.client = credential?.apiKey ? new GoogleClient(credential.apiKey, 'people') : null;
    this.mutationKey = createHash('sha256')
      .update(credential?.apiKey ?? '')
      .digest('hex');
  }
  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
  async listResources() {
    return [];
  }
  async readResource(): Promise<unknown> {
    throw new Error('Resource not found');
  }
  async listTools(): Promise<McpTool[]> {
    return this.operations.map((op) => ({
      name: op.name,
      description: op.description,
      inputSchema: z.toJSONSchema(op.schema) as McpTool['inputSchema'],
      annotations: {
        readOnlyHint: op.read === true,
        destructiveHint: op.destructive === true,
        idempotentHint: op.read === true,
        openWorldHint: true,
      },
    }));
  }
  async callTool(name: string, input: unknown, context?: ToolCallContext) {
    const op = this.operations.find((op) => op.name === name);
    if (!op) return this.failure('UNKNOWN_TOOL');
    if (!bounded(input)) return this.failure('INVALID_ARGUMENTS');
    const parsed = op.schema.safeParse(input ?? {});
    if (!parsed.success) return this.failure('INVALID_ARGUMENTS');
    if (!this.client) throw new UpstreamCredentialInvalidError();
    try {
      const run = () => op.run(this.client!, parsed.data as Args);
      const result = await withToolCallDeadline(
        20_000,
        () => (op.read ? run() : serialMutation(this.mutationKey, run)),
        context,
      );
      if (
        name === 'contacts_add_to_group' &&
        Array.isArray(result.notFoundResourceNames) &&
        result.notFoundResourceNames.length
      )
        return this.failure('CONTACT_NOT_FOUND');
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      if (error instanceof UpstreamCredentialInvalidError) throw error;
      if (error instanceof GoogleApiError)
        return this.failure(
          error.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
          error.status,
          error.retryAfterMs,
        );
      return this.failure('UPSTREAM_UNAVAILABLE');
    }
  }
  private failure(code: string, status?: number, retryAfterMs?: number) {
    const error = {
      code,
      ...(status !== undefined ? { status } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error }) }],
      structuredContent: { error },
    };
  }
}
export class GoogleContactsServer extends PeopleServer {
  constructor(credential: ApiKeyConfig | null) {
    super(credential, contactOperations);
  }
}
export class GoogleDirectoryServer extends PeopleServer {
  constructor(credential: ApiKeyConfig | null) {
    super(credential, directoryOperations);
  }
}
