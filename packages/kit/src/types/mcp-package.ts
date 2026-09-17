/** Public connector package contract derived from the original authoring contract.
 * Modified to omit discovery and OAuth configuration types. */
import type { McpServer } from '../abstractions/McpServer.js';
import type { ApiKeyConfig, ToolPermission } from './mcp.js';

export interface McpPackageMetadata {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  license?: string;
  requiresApiKey: boolean;
  apiKeyHint?: string;
  credentialLabel?: string;
  apiKeyDefaults?: { headerName: string; headerValueTemplate: string };
  tags?: string[];
  docsUrl?: string;
}
export interface McpSeedConfig {
  defaultProfile?: string | null;
  defaultOrder?: number;
  defaultActive?: boolean;
}
export type McpServerFactory = (apiKeyConfig: ApiKeyConfig | null) => McpServer;
export interface McpPackage {
  metadata: McpPackageMetadata;
  createServer: McpServerFactory;
  seed?: McpSeedConfig;
  defaultToolPermissions?: {
    readOnly?: ToolPermission;
    write?: ToolPermission;
    destructive?: ToolPermission;
  };
}
