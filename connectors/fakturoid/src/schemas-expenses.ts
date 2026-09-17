/**
 * Zod input schemas for expense tools, including expense payments.
 */

import { z } from 'zod';

// ── Expenses ───────────────────────────────────────────────────────

export const ListExpensesSchema = z.object({
  page: z.number().int().positive().optional().describe('Page number (starts at 1)'),
  since: z.string().optional().describe('Filter expenses created since this date'),
  updated_since: z.string().optional().describe('Filter expenses updated since this datetime'),
  status: z.enum(['open', 'overdue', 'paid']).optional().describe('Filter by expense status'),
  subject_id: z.number().int().positive().optional().describe('Filter by subject/contact ID'),
  number: z.string().optional().describe('Filter by expense number'),
  variable_symbol: z.string().optional().describe('Filter by variable symbol'),
  custom_id: z.string().optional().describe('Filter by custom ID'),
});

export const CreateExpenseSchema = z.object({
  subject_id: z.number().int().positive().optional().describe('Subject/contact ID'),
  custom_id: z.string().optional().describe('Custom identifier'),
  number: z.string().optional().describe('Expense document number'),
  original_number: z.string().optional().describe('Original document number from supplier'),
  variable_symbol: z.string().optional().describe('Variable symbol'),
  document_type: z.enum(['invoice', 'bill', 'other']).optional().describe('Expense document type'),
  payment_method: z
    .enum(['bank', 'cash', 'cod', 'paypal', 'card'])
    .optional()
    .describe('Payment method'),
  currency: z.string().optional().describe('Currency code'),
  exchange_rate: z.number().optional().describe('Exchange rate'),
  issued_on: z.string().optional().describe('Issue date (YYYY-MM-DD)'),
  received_on: z.string().optional().describe('Received date (YYYY-MM-DD)'),
  taxable_fulfillment_due: z.string().optional().describe('Date of taxable fulfillment'),
  due_on: z.string().optional().describe('Due date (YYYY-MM-DD)'),
  description: z.string().optional().describe('Expense description'),
  note: z.string().optional().describe('Note'),
  private_note: z.string().optional().describe('Private note (internal only)'),
  vat_price_mode: z
    .enum(['without_vat', 'from_total_with_vat'])
    .optional()
    .describe('VAT price calculation mode'),
  lines: z
    .array(
      z.object({
        name: z.string().describe('Line item name'),
        quantity: z.number().optional().describe('Quantity'),
        unit_name: z.string().optional().describe('Unit name'),
        unit_price: z.number().describe('Unit price'),
        vat_rate: z.number().optional().describe('VAT rate percentage'),
      }),
    )
    .min(1)
    .describe('Expense line items'),
  tags: z.array(z.string()).optional().describe('Tags'),
});

export const GetExpenseSchema = z.object({
  id: z.number().int().positive().describe('Expense ID'),
});

export const UpdateExpenseSchema = z.object({
  id: z.number().int().positive().describe('Expense ID'),
  subject_id: z.number().int().positive().optional().describe('Subject/contact ID'),
  custom_id: z.string().optional().describe('Custom identifier'),
  number: z.string().optional().describe('Expense document number'),
  original_number: z.string().optional().describe('Original document number from supplier'),
  variable_symbol: z.string().optional().describe('Variable symbol'),
  document_type: z.enum(['invoice', 'bill', 'other']).optional().describe('Expense document type'),
  payment_method: z
    .enum(['bank', 'cash', 'cod', 'paypal', 'card'])
    .optional()
    .describe('Payment method'),
  currency: z.string().optional().describe('Currency code'),
  exchange_rate: z.number().optional().describe('Exchange rate'),
  issued_on: z.string().optional().describe('Issue date (YYYY-MM-DD)'),
  received_on: z.string().optional().describe('Received date (YYYY-MM-DD)'),
  taxable_fulfillment_due: z.string().optional().describe('Date of taxable fulfillment'),
  due_on: z.string().optional().describe('Due date (YYYY-MM-DD)'),
  description: z.string().optional().describe('Expense description'),
  note: z.string().optional().describe('Note'),
  private_note: z.string().optional().describe('Private note (internal only)'),
  vat_price_mode: z
    .enum(['without_vat', 'from_total_with_vat'])
    .optional()
    .describe('VAT price calculation mode'),
  lines: z
    .array(
      z.object({
        name: z.string().describe('Line item name'),
        quantity: z.number().optional().describe('Quantity'),
        unit_name: z.string().optional().describe('Unit name'),
        unit_price: z.number().describe('Unit price'),
        vat_rate: z.number().optional().describe('VAT rate percentage'),
      }),
    )
    .optional()
    .describe('Expense line items (replaces existing)'),
  tags: z.array(z.string()).optional().describe('Tags'),
});

export const SearchExpensesSchema = z.object({
  query: z.string().min(1).describe('Search query'),
  page: z.number().int().positive().optional().describe('Page number'),
  tags: z.array(z.string()).optional().describe('Filter by tags'),
});

export const DeleteExpenseSchema = z.object({
  id: z.number().int().positive().describe('Expense ID'),
});

export const ExpenseActionSchema = z.object({
  id: z.number().int().positive().describe('Expense ID'),
  event: z.enum(['lock', 'unlock']).describe('Expense event/action to fire'),
});

// ── Expense Payments ──────────────────────────────────────────────

export const CreateExpensePaymentSchema = z.object({
  id: z.number().int().positive().describe('Expense ID'),
  paid_on: z.string().optional().describe('Payment date (YYYY-MM-DD, default: today)'),
  amount: z.number().optional().describe('Payment amount'),
  currency: z.string().optional().describe('Currency code'),
});

export const DeleteExpensePaymentSchema = z.object({
  expense_id: z.number().int().positive().describe('Expense ID'),
  payment_id: z.number().int().positive().describe('Payment ID'),
});
