/** Google service endpoints. The gateway owns per-user OAuth and credential storage. */
import type { McpPackage } from '@dxheroes/mcp-kit';
import type { ConnectorEndpoint } from '@dxheroes/mcp-runtime';
import { GoogleContactsServer, GoogleDirectoryServer } from './contacts.js';
import { GoogleTasksServer } from './tasks.js';
export const mcpPackage: McpPackage = {
  metadata: {
    id: 'google',
    name: 'Google Tasks',
    description: 'Task lists and tasks for personal and Workspace accounts using delegated OAuth.',
    version: '0.1.1',
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
export const endpoints: readonly ConnectorEndpoint[] = [
  { path: '/tasks/mcp', package: tasksPackage, auth: 'oauth' },
  { path: '/contacts/mcp', package: contactsPackage, auth: 'oauth' },
  { path: '/directory/mcp', package: directoryPackage, auth: 'oauth' },
];
export { GoogleContactsServer, GoogleDirectoryServer } from './contacts.js';
export { GoogleTasksServer } from './tasks.js';
export default mcpPackage;
