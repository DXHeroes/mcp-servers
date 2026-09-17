/**
 * Abra Flexi MCP Package
 *
 * Invoices, contacts, products, and accounting via the Abra Flexi REST API.
 * API docs: https://podpora.flexibee.eu/en/collections/2592813-dokumentacia-rest-api
 */

import type { ApiKeyConfig, McpPackage } from '@dxheroes/mcp-kit';
import { FlexiMcpServer } from './server.js';

export const mcpPackage: McpPackage = {
  metadata: {
    id: 'abra-flexi',
    name: 'Abra Flexi',
    description: 'Invoices, contacts, products, and accounting via the Abra Flexi REST API.',
    version: '0.1.1',
    author: 'DX Heroes',
    license: 'MIT',
    requiresApiKey: true,
    // Not an API key at all: a server URL with a company path, plus a username
    // and password. Renames the credential field everywhere it is asked for.
    credentialLabel: 'Server URL and credentials',
    apiKeyHint:
      'Format: https://server/c/company|username:password (e.g., "https://demo.flexibee.eu/c/demo|admin:admin"). The URL must include /c/company-name.',
    apiKeyDefaults: {
      headerName: 'Authorization',
      headerValueTemplate: 'Basic {apiKey}',
    },
    tags: ['erp', 'abra', 'flexibee', 'czech', 'accounting', 'invoicing'],
    docsUrl: 'https://podpora.flexibee.eu/en/collections/2592813-dokumentacia-rest-api',
  },

  createServer: (apiKeyConfig: ApiKeyConfig | null) => {
    return new FlexiMcpServer(apiKeyConfig);
  },

  seed: {},
};

export type { McpPackage } from '@dxheroes/mcp-kit';
export { FlexiApiError, FlexiClient } from './client.js';
export { FlexiMcpServer } from './server.js';

export default mcpPackage;
