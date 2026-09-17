/**
 * Shared tool vocabulary for the Abra Flexi MCP server.
 *
 * The annotation constants and the `ToolDef` shape are used by the tool
 * definition module (`tool-definitions.ts`) and by `server.ts`, which
 * dispatches on them.
 */

import type { ToolAnnotations } from '@dxheroes/mcp-kit';
import { z } from 'zod';

/**
 * MCP behaviour hints attached to every tool.
 *
 * The connector host classifies tools *only* by `annotations.readOnlyHint`
 * (`packages/kit/src/utils/tool-classification.ts`) and derives its
 * ALLOW / NEEDS_APPROVAL / BLOCKED defaults from that. With no annotations all
 * 30 tools land in the write group — the 16 read-only ones included — and an
 * operator has no way to say "allow the listings, ask before the writes".
 *
 * This package restricts nothing itself; these hints are what makes
 * restricting possible one layer up. Per the MCP spec they are hints, not a
 * security boundary.
 */
export const READ_ONLY_TOOL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Additive: creates a record, and loses nothing that existed before.
 *
 * Only the `flexi_create_*` family qualifies. "Not destructive" here is not a
 * claim that the write is harmless — creating an accounting document has real
 * consequences — only that no prior value is overwritten.
 */
export const WRITE_TOOL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

/**
 * Destructive in the MCP sense: the change is not purely additive.
 *
 * That covers `flexi_delete_record`, and it equally covers the whole
 * `flexi_update_*` family. A Flexi PUT changes only the fields it is given,
 * but each one replaces its previous value and the REST API offers no way to
 * read the old value back — an overwrite whose result cannot be undone from
 * here is not additive, whatever the tool is called.
 *
 * The connector host reads this: `destructiveHint` puts a tool in its own permission
 * group, so an operator can leave writes on ALLOW and still hold deletes and
 * overwrites at NEEDS_APPROVAL. Setting it truthfully is what makes that
 * switch mean anything.
 */
export const DESTRUCTIVE_TOOL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
};

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  annotations: ToolAnnotations;
  handler: (args: unknown) => Promise<unknown>;
}
