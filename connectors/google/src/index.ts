/** Google service endpoints. The gateway owns per-user OAuth and credential storage. */
import type { McpPackage } from '@dxheroes/mcp-kit';
import type { ConnectorEndpoint } from '@dxheroes/mcp-runtime';
import { GoogleTasksServer } from './tasks.js';
export const mcpPackage: McpPackage = {
  metadata: {
    id: 'google',
    name: 'Google Tasks',
    description: 'Task lists and tasks for personal and Workspace accounts using delegated OAuth.',
    version: '0.1.0',
    author: 'DX Heroes',
    license: 'MIT',
    requiresApiKey: true,
    docsUrl: 'https://developers.google.com/workspace/tasks/reference/rest',
  },
  createServer: (credential) => new GoogleTasksServer(credential),
};
export const endpoints: readonly ConnectorEndpoint[] = [
  { path: '/tasks/mcp', package: mcpPackage, auth: 'oauth' },
];
export { GoogleTasksServer } from './tasks.js';
export default mcpPackage;
