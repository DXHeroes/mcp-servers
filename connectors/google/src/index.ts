/** Google service endpoints. The gateway owns per-user OAuth and credential storage. */
import type { McpPackage } from '@dxheroes/mcp-kit';
import type { ConnectorEndpoint } from '@dxheroes/mcp-runtime';
import { GoogleContactsServer, GoogleDirectoryServer } from './contacts.js';
import { GoogleGmailServer } from './gmail.js';
import { GoogleGmailReadServer } from './gmail-read.js';
import { GoogleTasksServer } from './tasks.js';
export const mcpPackage: McpPackage = {
  metadata: {
    id: 'google',
    name: 'Google Tasks',
    description: 'Task lists and tasks for personal and Workspace accounts using delegated OAuth.',
    version: '0.3.0',
    author: 'DX Heroes',
    license: 'MIT',
    requiresApiKey: false,
    docsUrl: 'https://developers.google.com/workspace/tasks/reference/rest',
  },
  createServer: (credential) => new GoogleTasksServer(credential),
};
export const tasksPackage: McpPackage = {
  ...mcpPackage,
  metadata: {
    ...mcpPackage.metadata,
    id: 'google-tasks',
    oauthDefaults: {
      authorizationServerUrl: 'https://accounts.google.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/tasks'],
      authorizeParams: { access_type: 'offline', prompt: 'consent' },
      noMetadata: true,
    },
  },
};
export const contactsPackage: McpPackage = {
  ...tasksPackage,
  metadata: {
    ...tasksPackage.metadata,
    id: 'google-contacts',
    name: 'Google Contacts',
    description: 'Contact search and full contact mutations for personal and Workspace accounts.',
    docsUrl: 'https://developers.google.com/people/api/rest',
    oauthDefaults: {
      ...tasksPackage.metadata.oauthDefaults!,
      scopes: ['https://www.googleapis.com/auth/contacts'],
    },
  },
  createServer: (credential) => new GoogleContactsServer(credential),
};
export const directoryPackage: McpPackage = {
  ...tasksPackage,
  metadata: {
    ...tasksPackage.metadata,
    id: 'google-directory',
    name: 'Google Workspace Directory',
    description:
      'Read-only domain directory search for Workspace accounts with administrator-enabled directory sharing. Personal accounts are not supported.',
    docsUrl: 'https://developers.google.com/people/v1/directory',
    oauthDefaults: {
      ...tasksPackage.metadata.oauthDefaults!,
      scopes: ['https://www.googleapis.com/auth/directory.readonly'],
    },
  },
  createServer: (credential) => new GoogleDirectoryServer(credential),
};
export const gmailPackage: McpPackage = {
  ...tasksPackage,
  metadata: {
    ...tasksPackage.metadata,
    id: 'google-gmail-send',
    name: 'Gmail Send',
    description: 'Send email and replies for personal and Workspace accounts. No mailbox reads.',
    docsUrl: 'https://developers.google.com/workspace/gmail/api/guides/sending',
    oauthDefaults: {
      ...tasksPackage.metadata.oauthDefaults!,
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
    },
  },
  createServer: (credential) => new GoogleGmailServer(credential),
};
export const gmailReadPackage: McpPackage = {
  ...tasksPackage,
  metadata: {
    ...tasksPackage.metadata,
    id: 'google-gmail-read',
    name: 'Gmail Read',
    description: 'Read mailbox messages, threads and explicit bounded attachments. No sends.',
    docsUrl: 'https://developers.google.com/workspace/gmail/api/reference/rest',
    oauthDefaults: {
      ...tasksPackage.metadata.oauthDefaults!,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    },
  },
  createServer: (credential) => new GoogleGmailReadServer(credential),
};
export const endpoints: readonly ConnectorEndpoint[] = [
  { path: '/tasks/mcp', package: tasksPackage, auth: 'oauth' },
  { path: '/contacts/mcp', package: contactsPackage, auth: 'oauth' },
  { path: '/directory/mcp', package: directoryPackage, auth: 'oauth' },
  { path: '/gmail/mcp', package: gmailPackage, auth: 'oauth' },
  { path: '/gmail-read/mcp', package: gmailReadPackage, auth: 'oauth' },
];
export { GoogleContactsServer, GoogleDirectoryServer } from './contacts.js';
export { GoogleGmailServer } from './gmail.js';
export type { GmailMessageArgs } from './gmail-message.js';
export {
  buildGmailMessage,
  gmailReplySchema,
  gmailSendSchema,
  rfcMessageIdSchema,
} from './gmail-message.js';
export { GoogleGmailReadServer } from './gmail-read.js';
export { GoogleTasksServer } from './tasks.js';
export default mcpPackage;
