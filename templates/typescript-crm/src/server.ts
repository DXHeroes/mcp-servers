import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type ListToolsResult, Server } from '@modelcontextprotocol/server';
import { ContactStore } from './crm.js';

const host = process.env.MCP_HOST ?? '0.0.0.0';
const port = Number(process.env.MCP_PORT ?? 8080);
const packageMetadata = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { version?: unknown };
if (typeof packageMetadata.version !== 'string' || packageMetadata.version.length === 0)
  throw new Error('package.json must declare a version');
const runtimeVersion = packageMetadata.version;
const allowedHosts = new Set(
  (process.env.MCP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
const allowedOrigins = new Set(
  (process.env.MCP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const accessToken = await loadSecret('MCP_ACCESS_TOKEN');
if (!accessToken || allowedHosts.size === 0) {
  throw new Error('MCP_ACCESS_TOKEN[_FILE] and MCP_ALLOWED_HOSTS are required');
}

const store = new ContactStore();
function mcpFactory() {
  const server = new Server(
    { name: 'crm-template', version: runtimeVersion },
    { capabilities: { tools: {} } },
  );
  const tools: ListToolsResult['tools'] = [
    {
      name: 'crm_list_contacts',
      description: 'List CRM contacts ordered by name.',
      inputSchema: { type: 'object', additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'crm_get_contact',
      description: 'Get one CRM contact by ID.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1 } },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'crm_create_contact',
      description: 'Create a CRM contact.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          email: { type: 'string' },
          company: { type: 'string' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
  ];
  server.setRequestHandler('tools/list', () => ({ tools }));
  server.setRequestHandler('tools/call', (request) => {
    const args = request.params.arguments ?? {};
    let result: unknown;
    if (request.params.name === 'crm_list_contacts') result = store.list();
    else if (request.params.name === 'crm_get_contact') {
      const id = typeof args.id === 'string' ? args.id : '';
      result = store.get(id) ?? { error: 'not_found' };
    } else if (request.params.name === 'crm_create_contact') {
      if (typeof args.name !== 'string' || args.name.trim() === '')
        return { content: [{ type: 'text', text: 'name is required' }], isError: true };
      result = store.create({
        name: args.name.trim(),
        ...(typeof args.email === 'string' ? { email: args.email } : {}),
        ...(typeof args.company === 'string' ? { company: args.company } : {}),
      });
    } else return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: { result },
    };
  });
  return server;
}

const handler = createMcpHandler(mcpFactory, { legacy: 'stateless', responseMode: 'auto' });
const nodeHandler = toNodeHandler(handler);
const http = createServer({ maxHeaderSize: 65536, requestTimeout: 30000 }, (req, res) => {
  if (!requestAllowed(req)) return fail(res, 403, 'request_refused');
  if (!authorized(req)) return fail(res, 401, 'unauthorized');
  if (req.method === 'GET' && req.url === '/health') {
    res.setHeader('content-type', 'application/json');
    res.end('{"status":"ready"}');
    return;
  }
  if (req.url !== '/mcp') return fail(res, 404, 'not_found');
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');
  void readJsonBody(req, 2 * 1024 * 1024)
    .then((body) => nodeHandler(req, res, body))
    .catch((error) => {
      const failure =
        error instanceof RequestFailure ? error : new RequestFailure(400, 'bad_request');
      fail(res, failure.status, failure.code);
    });
});
http.listen(port, host);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    http.closeAllConnections();
    http.close(() => void handler.close());
  });
}

function requestAllowed(req: IncomingMessage): boolean {
  const authority = (req.headers.host ?? '').toLowerCase();
  const hostname = authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1)
    : authority.split(':')[0];
  if (!allowedHosts.has(hostname)) return false;
  const origin = req.headers.origin;
  return origin === undefined || allowedOrigins.has(origin);
}

function authorized(req: IncomingMessage): boolean {
  const actual = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${accessToken}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function fail(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
  });
  res.end(JSON.stringify({ error }));
}

class RequestFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
    throw new RequestFailure(415, 'json_required');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > maxBytes) throw new RequestFailure(413, 'body_too_large');
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestFailure(400, 'invalid_json');
  }
}

async function loadSecret(name: string): Promise<string | undefined> {
  const inline = process.env[name];
  const file = process.env[`${name}_FILE`];
  if (inline && file) throw new Error(`${name} and ${name}_FILE are mutually exclusive`);
  const value = file ? (await readFile(file, 'utf8')).replace(/\r?\n$/, '') : inline;
  return value && value.length > 0 ? value : undefined;
}
