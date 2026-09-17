/** Connector-facing MCP contracts derived from the original authoring contract.
 * Modified to omit configuration, transport, OAuth, and process types. */
import type { z } from 'zod';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
export interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
export interface McpTool {
  name: string;
  description: string;
  inputSchema: z.ZodType | JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}
export type ToolRiskTier = 'read-only' | 'write' | 'destructive';
export type ToolPermission = 'ALLOW' | 'NEEDS_APPROVAL' | 'BLOCKED';
export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}
export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}
export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgument[];
  _meta?: Record<string, unknown>;
}
export interface McpPromptMessage {
  role: 'user' | 'assistant';
  content: unknown;
}
export interface McpGetPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}
export interface ApiKeyConfig {
  apiKey: string;
  headerName: 'Authorization' | 'X-API-Key' | string;
  headerValue: string;
}
