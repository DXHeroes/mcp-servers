import { createServer } from 'node:http';
import { createConnectorHttpServer } from '@dxheroes/mcp-runtime';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createAdapter } from '../src/action-adapter.js';
import type { ActionRecord, MailGateway } from '../src/action-types.js';
import { endpoints, mcpPackage } from '../src/index.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => vi.unstubAllGlobals());
it('actual MCP send/read endpoints reconcile a committed MIME message after real HTTP connection loss', async () => {
  let writes = 0;
  let raw: string | undefined;
  const tokens: string[] = [];
  const provider = createServer(async (req, res) => {
    tokens.push(req.headers.authorization ?? '');
    const url = new URL(req.url!, 'http://fixture.test');
    let result: unknown;
    if (url.pathname.endsWith('/messages/send')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      raw = JSON.parse(body).raw;
      writes++;
      req.socket.destroy();
      return;
    }
    if (url.pathname.endsWith('/profile')) result = { emailAddress: 'sender@example.test' };
    else if (url.pathname.endsWith('/messages')) {
      expect(url.searchParams.get('q')).toMatch(/^in:sent rfc822msgid:</);
      result = {
        messages: raw ? [{ id: 'sent', threadId: 'thread' }] : [],
        resultSizeEstimate: raw ? 1 : 0,
      };
    } else {
      expect(url.pathname.endsWith('/messages/sent')).toBe(true);
      const mime = Buffer.from(raw!, 'base64url').toString('utf8');
      const [head, encoded] = mime.split('\r\n\r\n');
      const unfolded = head!.replace(/\r\n[ \t]+/g, ' ');
      const headers = unfolded.split('\r\n').map((line) => ({
        name: line.slice(0, line.indexOf(':')),
        value: line.slice(line.indexOf(':') + 1).trim(),
      }));
      const bytes = Buffer.from(encoded!.replace(/\s/g, ''), 'base64');
      result = {
        id: 'sent',
        threadId: 'thread',
        labelIds: ['SENT'],
        payload: {
          partId: '',
          mimeType: 'text/plain',
          headers,
          body: {
            size: bytes.length,
            ...(url.searchParams.get('fields')?.includes('body(size')
              ? {}
              : { data: bytes.toString('base64url') }),
          },
        },
      };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerPort = (provider.address() as { port: number }).port;
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    expect(url.origin).toBe('https://gmail.googleapis.com');
    return realFetch(`http://127.0.0.1:${providerPort}${url.pathname}${url.search}`, init);
  });
  const runtime = createConnectorHttpServer(
    mcpPackage,
    {
      host: '127.0.0.1',
      port: 0,
      allowedHosts: ['127.0.0.1'],
      allowedOrigins: [],
      accessToken: 'service-only',
      sharedCredential: undefined,
      localTestMode: false,
      maxBodyBytes: 128000,
      totalTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    },
    endpoints,
  );
  await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  const clients: Client[] = [];
  try {
    const connect = async (
      endpoint: string,
      token: string,
      aliases: Record<string, string>,
    ): Promise<MailGateway> => {
      const client = new Client({ name: 'mail-action-contract', version: '1' });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(
            `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}/${endpoint}/mcp`,
          ),
          {
            requestInit: {
              headers: {
                Authorization: 'Bearer service-only',
                'X-MCP-Credential-Mode': 'per_user',
                'X-MCP-Upstream-Credential': Buffer.from(token).toString('base64url'),
              },
            },
          },
        ),
      );
      return {
        call: async (alias, args) => {
          const result = await client.callTool({ name: aliases[alias]!, arguments: args });
          if (result.isError) throw Error('MCP refused');
          return result.structuredContent;
        },
      };
    };
    const gateway = await connect('gmail', 'host-send-only', {
      send: 'gmail_send_message',
      reply: 'gmail_reply_message',
    });
    const reader = await connect('gmail-read', 'read-only', {
      findSent: 'gmail_find_sent_message',
      getMessage: 'gmail_get_message',
      getAttachment: 'gmail_get_attachment',
    });
    const adapter = createAdapter({
      actor: 'agent-a',
      mailbox: 'sender@example.test',
      sender: 'sender@example.test',
      gateway,
      reader,
      authorize: async () => {},
    });
    const record: ActionRecord = {
      id: 'action-transport',
      route: 'mail',
      key: 'transport',
      kind: 'task',
      payload: {
        operation: 'send',
        to: ['recipient@example.test'],
        subject: 'Zkouška',
        text: 'Příliš žluťoučký kůň',
      },
      evidence: ['approval'],
      evidence_actors: ['agent-a'],
      actors: ['agent-a'],
      facts: [],
      steps: {},
      status: 'writing',
      created_at: '2026-11-11T00:00:00Z',
    };
    const step = adapter.steps(record, {
      adapter: 'mail',
      agents: ['agent-a'],
      audiences: ['owner'],
    })[0]!;
    expect(await step.read()).toEqual({ status: 'absent' });
    await expect(step.write()).rejects.toThrow();
    expect(writes).toBe(1);
    expect(await step.read()).toMatchObject({ status: 'found', receipt: { id: 'sent' } });
    expect(writes).toBe(1);
    expect(tokens.filter((t) => t === 'Bearer host-send-only')).toHaveLength(1);
    expect(tokens.every((t) => ['Bearer host-send-only', 'Bearer read-only'].includes(t))).toBe(
      true,
    );
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await runtime.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
