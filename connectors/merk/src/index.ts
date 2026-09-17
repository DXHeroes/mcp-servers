/**
 * Merk MCP Package
 *
 * Czech and Slovak company data — financials, relations, employees, fleet, and more.
 * API docs: https://api.merk.cz/docs/
 */

import type { ApiKeyConfig, McpPackage } from '@dxheroes/mcp-kit';
import { MerkMcpServer } from './server.js';

export const mcpPackage: McpPackage = {
  metadata: {
    id: 'merk',
    name: 'Merk',
    description:
      'Czech and Slovak company data — financials, relations, employees, fleet, and more.',
    version: '0.1.0',
    author: 'DX Heroes',
    license: 'MIT',
    requiresApiKey: true,
    apiKeyHint: 'Get your API key at https://www.merk.cz/api/about/',
    apiKeyDefaults: {
      headerName: 'Authorization',
      headerValueTemplate: 'Token {apiKey}',
    },
    tags: ['company-data', 'czech', 'slovak', 'financial', 'business-intelligence'],
    docsUrl: 'https://api.merk.cz/docs/',
  },

  createServer: (apiKeyConfig: ApiKeyConfig | null) => {
    return new MerkMcpServer(apiKeyConfig);
  },

  seed: {},
};

export type { McpPackage } from '@dxheroes/mcp-kit';
export { MerkApiError, MerkClient } from './client.js';
export { MerkMcpServer } from './server.js';

export default mcpPackage;
