/** Connector annotation classifier extracted from connector host. */
import type { ToolAnnotations, ToolRiskTier } from '../types/mcp.js';
export function classifyToolTier(annotations?: ToolAnnotations): ToolRiskTier {
  if (annotations?.readOnlyHint === true) return 'read-only';
  if (annotations?.destructiveHint === true) return 'destructive';
  return 'write';
}
