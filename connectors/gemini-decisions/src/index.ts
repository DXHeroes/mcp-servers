import type { McpPackage } from '@dxheroes/mcp-kit';
import { GeminiDecisionsMcpServer } from './server.js';

export { GeminiDecisionsMcpServer };
export const mcpPackage: McpPackage = {
  metadata: {
    id: 'gemini-decisions',
    name: 'Gemini Decisions',
    description: 'Evaluate named yes/no, choice and score questions over shared text and media.',
    version: '0.1.1',
    author: 'DX Heroes',
    license: 'MIT',
    docsUrl: 'https://aistudio.google.com/docs/decisions-api',
    tags: ['ai', 'google', 'gemini', 'decisions'],
    requiresApiKey: true,
    apiKeyHint: 'Gemini Developer API key from Google AI Studio.',
    apiKeyDefaults: { headerName: 'x-goog-api-key', headerValueTemplate: '{apiKey}' },
  },
  createServer: (config) => new GeminiDecisionsMcpServer(config),
  seed: {},
};
export default mcpPackage;
