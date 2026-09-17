/**
 * Zod input schemas for all Fakturoid MCP tools
 *
 * The per-domain schemas live in sibling modules only to keep each file under
 * Biome's 500-line ceiling; they are all re-exported here, so `./schemas.js`
 * stays the single import path for tool definitions.
 */

import { z } from 'zod';

export * from './schemas-catalog.js';
export * from './schemas-expenses.js';
export * from './schemas-invoices.js';
export * from './schemas-subjects.js';

// ── Account ────────────────────────────────────────────────────────

export const EmptySchema = z.object({});

// ── Users & Bank Accounts ─────────────────────────────────────────

// Uses EmptySchema (no params)
