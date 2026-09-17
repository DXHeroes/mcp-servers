/**
 * Zod input schemas for the catalog-side tools: inventory items and moves,
 * generators (invoice templates), recurring generators, events and todos.
 */

import { z } from 'zod';

// ── Inventory Items ───────────────────────────────────────────────

export const ListInventoryItemsSchema = z.object({
  page: z.number().int().positive().optional().describe('Page number (starts at 1)'),
});

export const GetInventoryItemSchema = z.object({
  id: z.number().int().positive().describe('Inventory item ID'),
});

export const CreateInventoryItemSchema = z.object({
  name: z.string().min(1).describe('Item name'),
  sku: z.string().optional().describe('Stock keeping unit (SKU)'),
  article_number: z.string().optional().describe('Article/catalog number'),
  unit_name: z.string().optional().describe('Unit name (e.g., "ks", "pcs")'),
  buy_price: z.number().optional().describe('Buy/purchase price'),
  sell_price: z.number().optional().describe('Sell price'),
  vat_rate: z.number().optional().describe('VAT rate percentage'),
  supply: z.number().optional().describe('Current supply/stock quantity'),
});

export const UpdateInventoryItemSchema = z.object({
  id: z.number().int().positive().describe('Inventory item ID'),
  name: z.string().optional().describe('Item name'),
  sku: z.string().optional().describe('Stock keeping unit (SKU)'),
  article_number: z.string().optional().describe('Article/catalog number'),
  unit_name: z.string().optional().describe('Unit name'),
  buy_price: z.number().optional().describe('Buy/purchase price'),
  sell_price: z.number().optional().describe('Sell price'),
  vat_rate: z.number().optional().describe('VAT rate percentage'),
  supply: z.number().optional().describe('Current supply/stock quantity'),
});

export const SearchInventoryItemsSchema = z.object({
  query: z.string().min(1).describe('Search query'),
  page: z.number().int().positive().optional().describe('Page number'),
});

// ── Inventory Moves ───────────────────────────────────────────────

export const ListInventoryMovesSchema = z.object({
  page: z.number().int().positive().optional().describe('Page number (starts at 1)'),
  since: z.string().optional().describe('Filter moves since this date (ISO 8601)'),
  inventory_item_id: z.number().int().positive().optional().describe('Filter by inventory item ID'),
});

export const CreateInventoryMoveSchema = z.object({
  inventory_item_id: z.number().int().positive().describe('Inventory item ID'),
  direction: z.enum(['in', 'out']).describe('Move direction: "in" (stock in) or "out" (stock out)'),
  quantity: z.number().positive().describe('Quantity to move'),
  price_per_unit: z.number().optional().describe('Price per unit'),
  moved_on: z.string().optional().describe('Date of move (YYYY-MM-DD, default: today)'),
});

// ── Generators (Invoice Templates) ────────────────────────────────

export const ListGeneratorsSchema = z.object({
  page: z.number().int().positive().optional().describe('Page number (starts at 1)'),
  since: z.string().optional().describe('Filter generators updated since this date'),
});

export const GetGeneratorSchema = z.object({
  id: z.number().int().positive().describe('Generator ID'),
});

export const CreateGeneratorSchema = z.object({
  name: z.string().min(1).describe('Generator/template name'),
  subject_id: z.number().int().positive().optional().describe('Subject/contact ID'),
  lines: z
    .array(
      z.object({
        name: z.string().describe('Line item name/description'),
        quantity: z.number().optional().describe('Quantity (default: 1)'),
        unit_name: z.string().optional().describe('Unit name'),
        unit_price: z.number().describe('Unit price (without VAT)'),
        vat_rate: z.number().optional().describe('VAT rate percentage'),
      }),
    )
    .optional()
    .describe('Template line items'),
});

// ── Recurring Generators ──────────────────────────────────────────

export const ListRecurringGeneratorsSchema = z.object({
  page: z.number().int().positive().optional().describe('Page number (starts at 1)'),
});

export const GetRecurringGeneratorSchema = z.object({
  id: z.number().int().positive().describe('Recurring generator ID'),
});

// ── Events (Audit Log) ───────────────────────────────────────────

export const ListEventsSchema = z.object({
  page: z.number().int().positive().optional().describe('Page number (starts at 1)'),
  since: z.string().optional().describe('Filter events since this date (ISO 8601)'),
  subject_id: z.number().int().positive().optional().describe('Filter by subject ID'),
});

// ── Todos ─────────────────────────────────────────────────────────

export const ListTodosSchema = z.object({
  page: z.number().int().positive().optional().describe('Page number (starts at 1)'),
  since: z.string().optional().describe('Filter todos since this date (ISO 8601)'),
});

export const ToggleTodoSchema = z.object({
  id: z.number().int().positive().describe('Todo ID'),
});
