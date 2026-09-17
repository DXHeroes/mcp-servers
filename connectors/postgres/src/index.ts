import type { ApiKeyConfig, McpPackage } from '@dxheroes/mcp-kit';
import { PostgresMcpServer } from './server.js';

export const mcpPackage: McpPackage = {
  metadata: {
    id: 'postgres',
    name: 'PostgreSQL',
    description:
      'Run SQL against a PostgreSQL database. A read-only tool that PostgreSQL itself refuses to let write, and a destructive one for changes; the connection details stay in the connector host and never reach the model.',
    version: '0.1.0',
    author: 'DX Heroes',
    license: 'MIT',
    // Each connector instance requires its own PostgreSQL connection credential.
    requiresApiKey: true,
    // `requiresApiKey` cannot say WHAT the secret is, so every field asking for
    // it read "API key" — and in the per-user dialog, "Your token". This is the
    // one field that renames all three (presentation only; the value is still
    // stored as `apiKeyConfig`).
    credentialLabel: 'Connection string',
    // The only format copy the end user ever sees, so it spells out both
    // accepted forms, their separators, what is required, how to supply a
    // private CA, and the consequence of the host living inside the credential.
    // It no longer opens by naming the credential — `credentialLabel` above is
    // on the same screen, as the field's own label.
    apiKeyHint:
      'Two accepted forms. (1) URL: postgresql://user:password@host:5432/dbname?sslmode=require (postgres:// works too). (2) Keyword form, fields separated by spaces or semicolons: host=db.example.com port=5432 dbname=mydb user=myuser password=secret sslmode=require. Required: host, dbname, user. Defaults: port=5432 and sslmode=prefer. What prefer does, exactly: it attempts an encrypted connection and drops to an unencrypted one only if the server itself reports that it has no TLS support — but it verifies no certificate, so it is not protection against someone who can intercept the connection (they can force the unencrypted fallback). Use sslmode=require to refuse an unencrypted connection, and verify-full to also verify the certificate the server presents. Accepted sslmode: disable, allow, prefer, require, verify-ca, verify-full (allow behaves like prefer here; it tries TLS first). For a database whose certificate comes from a private or internal CA, add sslrootcert=<PEM certificate(s), base64url-encoded> (a bundle of several concatenated certificates is fine) and sslmode=verify-full; without it, verify-ca/verify-full trust only the system CA store. Note: the database host is part of this credential, so with per-user credentials each user chooses their own database server.',
    tags: ['database', 'postgres', 'postgresql', 'sql'],
    docsUrl: 'https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING',
  },
  createServer: (apiKeyConfig: ApiKeyConfig | null) => new PostgresMcpServer(apiKeyConfig),
  // An install cannot know whether the credential is a SELECT-only user or a
  // superuser, so writes start off and stay a deliberate act.
  defaultToolPermissions: {
    destructive: 'BLOCKED',
  },
  seed: {},
};

export type { McpPackage } from '@dxheroes/mcp-kit';
export {
  type ConnectionTarget,
  type MultiStatementEnvelope,
  PostgresClient,
  PostgresError,
  type PostgresErrorCode,
  parseCredential,
  type SqlResultEnvelope,
  type TruncationReason,
} from './client.js';
export { executeSqlSchema, querySchema } from './schemas.js';
export { PostgresMcpServer } from './server.js';
export default mcpPackage;
