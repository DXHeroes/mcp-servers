import type { McpPackage } from '@dxheroes/mcp-kit';
import type { ConnectorEndpoint } from '@dxheroes/mcp-runtime';
import { OutlookCalendarServer } from './calendar.js';
import { OutlookMailServer } from './mail.js';

const oauth = {
  authorizationServerUrl: 'https://login.microsoftonline.com/common/v2.0',
  authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  noMetadata: true,
  authorizeParams: { prompt: 'select_account' },
};
export const mailPackage: McpPackage = {
  metadata: {
    id: 'outlook-mail',
    name: 'Outlook Mail',
    description: 'Delegated Outlook mail for work, school and personal Microsoft accounts.',
    version: '0.1.1',
    author: 'DX Heroes',
    license: 'MIT',
    requiresApiKey: false,
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview',
    oauthDefaults: {
      ...oauth,
      scopes: [
        'User.Read',
        'offline_access',
        'Mail.ReadWrite',
        'Mail.Send',
        'MailboxSettings.Read',
      ],
    },
  },
  createServer: (credential) => new OutlookMailServer(credential),
};
export const calendarPackage: McpPackage = {
  metadata: {
    ...mailPackage.metadata,
    id: 'outlook-calendar',
    name: 'Outlook Calendar',
    description: 'Delegated Outlook calendar for work, school and personal Microsoft accounts.',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/calendar-overview',
    oauthDefaults: { ...oauth, scopes: ['User.Read', 'offline_access', 'Calendars.ReadWrite'] },
  },
  createServer: (credential) => new OutlookCalendarServer(credential),
};
/** Package identity only; HTTP/catalog expose the two explicit service offers. */
export const mcpPackage: McpPackage = {
  ...mailPackage,
  metadata: { ...mailPackage.metadata, id: 'outlook', name: 'Outlook' },
};
export const endpoints: readonly ConnectorEndpoint[] = [
  { path: '/mail/mcp', package: mailPackage, auth: 'oauth' },
  { path: '/calendar/mcp', package: calendarPackage, auth: 'oauth' },
];
export { OutlookCalendarServer, OutlookMailServer };
export default mcpPackage;
