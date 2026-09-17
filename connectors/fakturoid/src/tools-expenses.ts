/**
 * Fakturoid tool definitions: the money going out and the supporting records.
 *
 * Expenses and their payments, inventory items and moves, invoice generators
 * (one-off and recurring), and the account-level lookups — events, todos,
 * number formats and tags.
 */

import { z } from 'zod';
import type { FakturoidClient } from './client.js';
import {
  CreateExpensePaymentSchema,
  CreateExpenseSchema,
  CreateGeneratorSchema,
  CreateInventoryItemSchema,
  CreateInventoryMoveSchema,
  DeleteExpensePaymentSchema,
  DeleteExpenseSchema,
  EmptySchema,
  ExpenseActionSchema,
  GetExpenseSchema,
  GetGeneratorSchema,
  GetInventoryItemSchema,
  GetRecurringGeneratorSchema,
  ListEventsSchema,
  ListExpensesSchema,
  ListGeneratorsSchema,
  ListInventoryItemsSchema,
  ListInventoryMovesSchema,
  ListRecurringGeneratorsSchema,
  ListTodosSchema,
  SearchExpensesSchema,
  SearchInventoryItemsSchema,
  ToggleTodoSchema,
  UpdateExpenseSchema,
  UpdateInventoryItemSchema,
} from './schemas.js';
import { DESTRUCTIVE_TOOL, READ_ONLY_TOOL, type ToolDef, WRITE_TOOL } from './tool-annotations.js';

export function buildExpenseToolDefs(c: FakturoidClient): ToolDef[] {
  return [
    // ── Expenses ─────────────────────────────────────────────────
    {
      name: 'fakturoid_list_expenses',
      description:
        'List expenses with optional filtering by status, subject, or date. Returns 40 items per page.',
      inputSchema: ListExpensesSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listExpenses(args as z.infer<typeof ListExpensesSchema>),
    },
    {
      name: 'fakturoid_create_expense',
      description: 'Create a new expense record with line items.',
      inputSchema: CreateExpenseSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createExpense(args as Record<string, unknown>),
    },
    {
      name: 'fakturoid_get_expense',
      description: 'Get full details of a specific expense by ID.',
      inputSchema: GetExpenseSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.getExpense(args as z.infer<typeof GetExpenseSchema>),
    },
    {
      name: 'fakturoid_update_expense',
      description:
        'DESTRUCTIVE: overwrites the fields you pass on an existing expense. This client cannot read a ' +
        'previous version back, so the earlier amounts, dates, supplier or notes are gone from a ' +
        "caller's point of view — read the expense with fakturoid_get_expense first and pass only the " +
        'fields you mean to change. Fakturoid answers 403 if the expense is locked; unlock it with ' +
        'fakturoid_expense_action first.',
      inputSchema: UpdateExpenseSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => {
        const { id, ...data } = args as z.infer<typeof UpdateExpenseSchema>;
        return c.updateExpense({ id }, data);
      },
    },
    {
      name: 'fakturoid_search_expenses',
      description: 'Full-text search expenses.',
      inputSchema: SearchExpensesSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.searchExpenses(args as z.infer<typeof SearchExpensesSchema>),
    },
    {
      name: 'fakturoid_delete_expense',
      description:
        'DESTRUCTIVE: deletes an expense record. The Fakturoid web app documents an undo right after a ' +
        'deletion and a trash on paid plans, but the API exposes no restore endpoint and this tool set ' +
        'has none, so from here it cannot be undone. To correct an expense instead of removing it, use ' +
        'fakturoid_update_expense.',
      inputSchema: DeleteExpenseSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => c.deleteExpense(args as z.infer<typeof DeleteExpenseSchema>),
    },
    {
      name: 'fakturoid_expense_action',
      description:
        'Lock or unlock an expense. Locking blocks further edits — fakturoid_update_expense then ' +
        'answers 403 — and unlock reverses it exactly, which is why this is not marked destructive even ' +
        'though it writes.',
      inputSchema: ExpenseActionSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.expenseAction(args as z.infer<typeof ExpenseActionSchema>),
    },

    // ── Expense Payments ──────────────────────────────────────────
    {
      name: 'fakturoid_create_expense_payment',
      description: 'Create a payment for an expense.',
      inputSchema: CreateExpensePaymentSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createExpensePayment(args as z.infer<typeof CreateExpensePaymentSchema>),
    },
    {
      name: 'fakturoid_delete_expense_payment',
      description:
        'DESTRUCTIVE: removes a recorded payment from an expense, which also takes the expense back out ' +
        'of its paid state. There is no restore endpoint — re-recording it with ' +
        'fakturoid_create_expense_payment produces a new payment, not the one that was removed. Read ' +
        'the expense with fakturoid_get_expense first to confirm which payment_id you mean.',
      inputSchema: DeleteExpensePaymentSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => c.deleteExpensePayment(args as z.infer<typeof DeleteExpensePaymentSchema>),
    },

    // ── Inventory Items ───────────────────────────────────────────
    {
      name: 'fakturoid_list_inventory_items',
      description: 'List inventory items. Returns 40 items per page.',
      inputSchema: ListInventoryItemsSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listInventoryItems(args as z.infer<typeof ListInventoryItemsSchema>),
    },
    {
      name: 'fakturoid_get_inventory_item',
      description: 'Get full details of a specific inventory item by ID.',
      inputSchema: GetInventoryItemSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.getInventoryItem(args as z.infer<typeof GetInventoryItemSchema>),
    },
    {
      name: 'fakturoid_create_inventory_item',
      description: 'Create a new inventory item with name, SKU, prices, and VAT rate.',
      inputSchema: CreateInventoryItemSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createInventoryItem(args as Record<string, unknown>),
    },
    {
      name: 'fakturoid_update_inventory_item',
      description:
        'DESTRUCTIVE: overwrites the fields you pass on an existing inventory item. This client cannot ' +
        'read a previous version back, so the earlier name, SKU, prices or VAT rate are gone from a ' +
        "caller's point of view — read the item with fakturoid_get_inventory_item first and pass only " +
        'the fields you mean to change. supply is the sharpest edge: it sets the stock quantity ' +
        'outright, with no inventory move recording why it changed, so use ' +
        'fakturoid_create_inventory_move whenever stock actually moved and reserve supply for ' +
        'correcting a count.',
      inputSchema: UpdateInventoryItemSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => {
        const { id, ...data } = args as z.infer<typeof UpdateInventoryItemSchema>;
        return c.updateInventoryItem({ id }, data);
      },
    },
    {
      name: 'fakturoid_search_inventory_items',
      description: 'Search inventory items by name, SKU, or article number.',
      inputSchema: SearchInventoryItemsSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.searchInventoryItems(args as z.infer<typeof SearchInventoryItemsSchema>),
    },

    // ── Inventory Moves ───────────────────────────────────────────
    {
      name: 'fakturoid_list_inventory_moves',
      description:
        'List inventory moves with optional filtering by item or date. Returns 40 items per page.',
      inputSchema: ListInventoryMovesSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listInventoryMoves(args as z.infer<typeof ListInventoryMovesSchema>),
    },
    {
      name: 'fakturoid_create_inventory_move',
      description:
        'Create an inventory move (stock in or out) for a specific inventory item. This is the ' +
        'auditable way to change stock: the move stays on the record, unlike setting supply through ' +
        'fakturoid_update_inventory_item.',
      inputSchema: CreateInventoryMoveSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createInventoryMove(args as z.infer<typeof CreateInventoryMoveSchema>),
    },

    // ── Generators (Invoice Templates) ────────────────────────────
    {
      name: 'fakturoid_list_generators',
      description: 'List invoice generators/templates. Returns 40 items per page.',
      inputSchema: ListGeneratorsSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listGenerators(args as z.infer<typeof ListGeneratorsSchema>),
    },
    {
      name: 'fakturoid_get_generator',
      description: 'Get full details of a specific generator/template by ID.',
      inputSchema: GetGeneratorSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.getGenerator(args as z.infer<typeof GetGeneratorSchema>),
    },
    {
      name: 'fakturoid_create_generator',
      description: 'Create a new invoice generator/template.',
      inputSchema: CreateGeneratorSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createGenerator(args as Record<string, unknown>),
    },

    // ── Recurring Generators ──────────────────────────────────────
    {
      name: 'fakturoid_list_recurring_generators',
      description: 'List recurring invoice generators. Returns 40 items per page.',
      inputSchema: ListRecurringGeneratorsSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) =>
        c.listRecurringGenerators(args as z.infer<typeof ListRecurringGeneratorsSchema>),
    },
    {
      name: 'fakturoid_get_recurring_generator',
      description: 'Get full details of a specific recurring generator by ID.',
      inputSchema: GetRecurringGeneratorSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) =>
        c.getRecurringGenerator(args as z.infer<typeof GetRecurringGeneratorSchema>),
    },

    // ── Events (Audit Log) ────────────────────────────────────────
    {
      name: 'fakturoid_list_events',
      description:
        'List account events/audit log. Filter by date or subject. Returns 40 items per page.',
      inputSchema: ListEventsSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listEvents(args as z.infer<typeof ListEventsSchema>),
    },

    // ── Todos ─────────────────────────────────────────────────────
    {
      name: 'fakturoid_list_todos',
      description: 'List todos/tasks. Returns 40 items per page.',
      inputSchema: ListTodosSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listTodos(args as z.infer<typeof ListTodosSchema>),
    },
    {
      name: 'fakturoid_toggle_todo',
      description:
        'Toggle the completion status of a todo. Reversible by calling it again, but it flips whatever ' +
        'the current state is rather than setting one, so read the current state with ' +
        'fakturoid_list_todos if you need a specific outcome.',
      inputSchema: ToggleTodoSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.toggleTodo(args as z.infer<typeof ToggleTodoSchema>),
    },

    // ── Number Formats ────────────────────────────────────────────
    {
      name: 'fakturoid_list_number_formats',
      description: 'List all available number formats for invoices and expenses.',
      inputSchema: EmptySchema,
      annotations: READ_ONLY_TOOL,
      handler: () => c.listNumberFormats(),
    },

    // ── Tags ─────────────────────────────────────────────────────
    {
      name: 'fakturoid_list_tags',
      description: 'List all tags used in the Fakturoid account.',
      inputSchema: EmptySchema,
      annotations: READ_ONLY_TOOL,
      handler: () => c.listTags(),
    },
  ];
}
