import type { McpPackage } from '@dxheroes/mcp-kit';
import type { ConnectorEndpoint } from '@dxheroes/mcp-runtime';
import { MicrosoftTeamsServer } from './teams.js';
export const mcpPackage: McpPackage = {
  metadata: {
    id: 'microsoft-teams',
    name: 'Microsoft Teams',
    description:
      'Chats and channels for work or school Microsoft accounts; personal accounts cannot connect.',
    version: '0.1.0',
    author: 'DX Heroes',
    license: 'MIT',
    requiresApiKey: false,
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview',
    oauthDefaults: {
      authorizationServerUrl: 'https://login.microsoftonline.com/organizations/v2.0',
      authorizationEndpoint:
        'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
      tokenEndpoint: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
      noMetadata: true,
      authorizeParams: { prompt: 'select_account' },
      scopes: [
        'User.Read',
        'offline_access',
        'Chat.ReadWrite',
        'ChannelMessage.Read.All',
        'ChannelMessage.Send',
        'Team.ReadBasic.All',
        'Channel.ReadBasic.All',
        'User.ReadBasic.All',
      ],
    },
  },
  createServer: (credential) => new MicrosoftTeamsServer(credential),
};
export const endpoints: readonly ConnectorEndpoint[] = [
  { path: '/mcp', package: mcpPackage, auth: 'oauth' },
];
export { MicrosoftTeamsServer };
export default mcpPackage;
