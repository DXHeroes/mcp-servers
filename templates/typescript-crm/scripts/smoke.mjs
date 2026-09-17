import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const endpoint = new URL(process.env.MCP_SMOKE_URL ?? 'http://127.0.0.1:8080/mcp');
const token = process.env.MCP_SMOKE_TOKEN;
if (!token) throw new Error('MCP_SMOKE_TOKEN is required');
const client = new Client(
  { name: 'crm-template-smoke', version: '0.1.0' },
  { versionNegotiation: { mode: 'auto' } },
);
await client.connect(
  new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);
try {
  const tools = await client.listTools();
  if (
    tools.tools.map((tool) => tool.name).join(',') !==
    'crm_list_contacts,crm_get_contact,crm_create_contact'
  )
    throw new Error('unexpected tool surface');
  const created = await client.callTool({
    name: 'crm_create_contact',
    arguments: { name: 'Smoke Test', email: 'smoke@example.test' },
  });
  if (!JSON.stringify(created).includes('Smoke Test')) throw new Error('create failed');
  const listed = await client.callTool({ name: 'crm_list_contacts', arguments: {} });
  if (!JSON.stringify(listed).includes('Smoke Test')) throw new Error('list failed');
  console.log('CRM MCP smoke passed');
} finally {
  await client.close();
}
