/**
 * Toggl Track MCP Package
 *
 * Time tracking, projects, tasks, clients, tags and reporting via the Toggl
 * Track API v9 and Reports API v3.
 * API docs: https://engineering.toggl.com/docs/api/
 */

import type { ApiKeyConfig, McpPackage } from '@dxheroes/mcp-kit';
import { TogglMcpServer } from './server.js';

export const mcpPackage: McpPackage = {
  metadata: {
    id: 'toggl',
    name: 'Toggl Track',
    description:
      'Time tracking via the Toggl Track API: start and stop timers, log and correct time entries, manage projects, tasks, clients and tags, and run summary, detailed and weekly reports. Tasks and client archiving require a paid Toggl plan; deletions are permanent, so the delete tools are annotated as destructive for per-profile approval.',
    version: '0.1.0',
    author: 'DX Heroes',
    license: 'MIT',
    requiresApiKey: true,
    apiKeyHint: 'Get your API token at https://track.toggl.com/profile (scroll to "API Token")',
    apiKeyDefaults: {
      headerName: 'Authorization',
      headerValueTemplate: 'Basic {apiKey}',
    },
    tags: [
      'time-tracking',
      'toggl',
      'reports',
      'productivity',
      'projects',
      'tasks',
      'clients',
      'tags',
      'timesheets',
    ],
    docsUrl: 'https://engineering.toggl.com/docs/api/',
  },

  createServer: (apiKeyConfig: ApiKeyConfig | null) => {
    return new TogglMcpServer(apiKeyConfig);
  },

  seed: {},
};

export type { McpPackage } from '@dxheroes/mcp-kit';
export { TogglApiError, TogglClient } from './client.js';
export { TogglMcpServer } from './server.js';

export default mcpPackage;
