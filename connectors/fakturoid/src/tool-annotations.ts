/**
 * Shared tool vocabulary for the Fakturoid MCP server.
 *
 * The annotation constants and the `ToolDef` shape are used by every tool
 * definition module (`tools-invoicing.ts`, `tools-expenses.ts`) and by
 * `server.ts`, which dispatches on them.
 */

import type { ToolAnnotations } from '@dxheroes/mcp-kit';
import { z } from 'zod';

/**
 * MCP behaviour hints attached to every tool.
 *
 * The connector host classifies tools *only* by `annotations.readOnlyHint`
 * (`packages/kit/src/utils/tool-classification.ts`) and derives its
 * ALLOW / NEEDS_APPROVAL / BLOCKED defaults from that. With no annotations all
 * 45 tools land in the write group — the 24 read-only ones included — and an
 * operator has no way to say "let it read the invoices, ask before it deletes
 * one". On accounting data that is the difference between a usable tool set
 * and one nobody dares connect.
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
 * Additive: creates a record, or makes a change that loses nothing.
 *
 * Not "anything that can be set again". An overwrite qualifies only when the
 * previous value stays recoverable — which for Fakturoid means the paired
 * inverse call is in this same tool set (`fakturoid_expense_action` lock and
 * unlock, `fakturoid_toggle_todo`). Everything else that writes over an
 * existing field carries `DESTRUCTIVE_TOOL` instead.
 */
export const WRITE_TOOL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

/**
 * Destructive in the MCP sense: the change is not purely additive.
 *
 * Three things land here. The deletes, obviously. Then the update family:
 * Fakturoid's PATCH endpoints overwrite the fields passed to them and this
 * client offers no way to read a previous version back, so the old value is
 * gone as far as any caller here is concerned — and for `lines` on an invoice
 * the schema replaces the whole set rather than editing one row. Finally the
 * calls whose effect reaches outside the account and cannot be recalled:
 * emailing an invoice to a customer, and the invoice event tool, whose event
 * list includes `cancel` and `remove_payment`.
 *
 * The connector host reads this: `destructiveHint` puts a tool in its own permission
 * group, so an operator can leave the ten additive writes on ALLOW and still
 * hold these eleven at NEEDS_APPROVAL. Setting it truthfully is what makes
 * that switch mean anything.
 *
 * It is not a ranking either. `fakturoid_update_invoice` is destructive *and*
 * the safer answer than `fakturoid_delete_invoice` for most "this invoice is
 * wrong" intents, so its description says so rather than leaving the model to
 * read the flag as a warning against it.
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
