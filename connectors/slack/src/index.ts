import type { McpPackage } from '@dxheroes/mcp-kit';
import type { ConnectorEndpoint } from '@dxheroes/mcp-runtime';
import { SlackServer } from './slack.js';
export const mcpPackage: McpPackage = {
  metadata: {
    id: 'slack',
    name: 'Slack (internal bridge)',
    description:
      'Internal Slack Web API pilot with delegated user tokens; migrate to the official Slack MCP server after provider approval.',
    version: '0.1.0',
    author: 'DX Heroes',
    license: 'MIT',
    requiresApiKey: false,
    docsUrl: 'https://docs.slack.dev/apis/web-api/',
    oauthDefaults: {
      authorizationServerUrl: 'https://slack.com',
      authorizationEndpoint: 'https://slack.com/oauth/v2_user/authorize',
      tokenEndpoint: 'https://slack.com/api/oauth.v2.user.access',
      noMetadata: true,
      scopes: [
        'channels:read',
        'channels:history',
        'groups:read',
        'groups:history',
        'im:read',
        'im:history',
        'users:read',
        'chat:write',
        'reactions:write',
        'search:read',
      ],
    },
  },
  createServer: (credential) => new SlackServer(credential),
};
export const endpoints: readonly ConnectorEndpoint[] = [
  { path: '/mcp', package: mcpPackage, auth: 'oauth' },
];
export { SlackServer };
export default mcpPackage;
