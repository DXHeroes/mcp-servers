/**
 * Zod input schemas for invoice tools: invoices themselves, the events fired
 * on them, their payments and the messages sent out with them.
 */

import { z } from 'zod';

// ── Invoices ───────────────────────────────────────────────────────

export const ListInvoicesSchema = z.object({
  page: z.number().int().positive().optional().describe('Page number (starts at 1)'),
  since: z.string().optional().describe('Filter invoices created since this date (ISO 8601)'),
  until: z.string().optional().describe('Filter invoices created before this date (ISO 8601)'),
  updated_since: z.string().optional().describe('Filter invoices updated since this datetime'),
  updated_until: z.string().optional().describe('Filter invoices updated before this datetime'),
  number: z.string().optional().describe('Filter by invoice number'),
  status: z
    .enum(['open', 'sent', 'overdue', 'paid', 'cancelled', 'uncollectible'])
    .optional()
    .describe('Filter by invoice status'),
  subject_id: z.number().int().positive().optional().describe('Filter by subject/contact ID'),
  custom_id: z.string().optional().describe('Filter by custom ID'),
  document_type: z
    .enum(['regular', 'proforma', 'correction', 'tax_document'])
    .optional()
    .describe('Filter by document type'),
});

export const GetInvoiceSchema = z.object({
  id: z.number().int().positive().describe('Invoice ID'),
});

const InvoiceLineSchema = z.object({
  name: z.string().describe('Line item name/description'),
  quantity: z.number().optional().describe('Quantity (default: 1)'),
  unit_name: z.string().optional().describe('Unit name (e.g., "ks", "hod", "pcs")'),
  unit_price: z.number().describe('Unit price (without VAT)'),
  vat_rate: z.number().optional().describe('VAT rate percentage (e.g., 21, 15, 10, 0)'),
  inventory_item_id: z.number().int().positive().optional().describe('Link to inventory item'),
  sku: z.string().optional().describe('Stock keeping unit'),
});

export const CreateInvoiceSchema = z.object({
  subject_id: z.number().int().positive().describe('Subject/contact ID for the invoice'),
  custom_id: z.string().optional().describe('Custom identifier'),
  document_type: z
    .enum([
      'invoice',
      'proforma',
      'partial_proforma',
      'correction',
      'tax_document',
      'final_invoice',
    ])
    .optional()
    .describe('Document type'),
  number: z.string().optional().describe('Document number (auto-generated if omitted)'),
  variable_symbol: z.string().optional().describe('Variable symbol (auto-calculated if omitted)'),
  order_number: z.string().optional().describe('Order number'),
  payment_method: z
    .enum(['bank', 'cash', 'cod', 'paypal', 'card', 'custom'])
    .optional()
    .describe('Payment method'),
  custom_payment_method: z
    .string()
    .optional()
    .describe('Custom payment method name (max 20 chars)'),
  currency: z.string().optional().describe('Currency code (e.g., "CZK", "EUR", "USD")'),
  exchange_rate: z
    .number()
    .optional()
    .describe('Exchange rate (required if currency differs from account)'),
  language: z
    .enum(['cz', 'sk', 'en', 'de', 'fr', 'it', 'es', 'ru', 'pl', 'hu', 'ro'])
    .optional()
    .describe('Invoice language'),
  due: z.number().int().optional().describe('Due in days (default: 14)'),
  issued_on: z.string().optional().describe('Issue date (YYYY-MM-DD, default: today)'),
  taxable_fulfillment_due: z
    .string()
    .optional()
    .describe('Date of taxable fulfillment (YYYY-MM-DD)'),
  note: z.string().optional().describe('Note displayed on the invoice (before lines)'),
  footer_note: z.string().optional().describe('Footer note on the invoice'),
  private_note: z.string().optional().describe('Private note (not visible to client)'),
  bank_account_id: z.number().int().positive().optional().describe('Bank account ID to display'),
  vat_price_mode: z
    .enum(['without_vat', 'from_total_with_vat'])
    .optional()
    .describe('VAT price calculation mode'),
  round_total: z.boolean().optional().describe('Round total amount'),
  transferred_tax_liability: z
    .boolean()
    .optional()
    .describe('Reverse charge (transferred tax liability)'),
  supply_code: z.string().optional().describe('Supply code for reverse charge'),
  oss: z.enum(['disabled', 'service', 'goods']).optional().describe('One Stop Shop (OSS) mode'),
  lines: z.array(InvoiceLineSchema).min(1).describe('Invoice line items'),
  tags: z.array(z.string()).optional().describe('Tags for the invoice'),
});

export const UpdateInvoiceSchema = z.object({
  id: z.number().int().positive().describe('Invoice ID'),
  subject_id: z.number().int().positive().optional().describe('Subject/contact ID'),
  custom_id: z.string().optional().describe('Custom identifier'),
  document_type: z
    .enum([
      'invoice',
      'proforma',
      'partial_proforma',
      'correction',
      'tax_document',
      'final_invoice',
    ])
    .optional()
    .describe('Document type'),
  variable_symbol: z.string().optional().describe('Variable symbol'),
  order_number: z.string().optional().describe('Order number'),
  payment_method: z
    .enum(['bank', 'cash', 'cod', 'paypal', 'card', 'custom'])
    .optional()
    .describe('Payment method'),
  custom_payment_method: z
    .string()
    .optional()
    .describe('Custom payment method name (max 20 chars)'),
  currency: z.string().optional().describe('Currency code'),
  exchange_rate: z.number().optional().describe('Exchange rate'),
  language: z
    .enum(['cz', 'sk', 'en', 'de', 'fr', 'it', 'es', 'ru', 'pl', 'hu', 'ro'])
    .optional()
    .describe('Invoice language'),
  due: z.number().int().optional().describe('Due in days'),
  issued_on: z.string().optional().describe('Issue date (YYYY-MM-DD)'),
  taxable_fulfillment_due: z
    .string()
    .optional()
    .describe('Date of taxable fulfillment (YYYY-MM-DD)'),
  note: z.string().optional().describe('Note displayed on the invoice'),
  footer_note: z.string().optional().describe('Footer note on the invoice'),
  private_note: z.string().optional().describe('Private note (not visible to client)'),
  bank_account_id: z.number().int().positive().optional().describe('Bank account ID'),
  vat_price_mode: z
    .enum(['without_vat', 'from_total_with_vat'])
    .optional()
    .describe('VAT price calculation mode'),
  round_total: z.boolean().optional().describe('Round total amount'),
  transferred_tax_liability: z.boolean().optional().describe('Reverse charge'),
  lines: z.array(InvoiceLineSchema).optional().describe('Invoice line items (replaces existing)'),
  tags: z.array(z.string()).optional().describe('Tags for the invoice'),
});

export const InvoiceActionSchema = z.object({
  id: z.number().int().positive().describe('Invoice ID'),
  event: z
    .enum([
      'mark_as_sent',
      'deliver',
      'pay',
      'pay_proforma',
      'pay_partial_proforma',
      'remove_payment',
      'deliver_reminder',
      'cancel',
      'undo_cancel',
      'lock',
      'unlock',
      'mark_as_uncollectible',
      'undo_uncollectible',
    ])
    .describe('Invoice event/action to fire'),
  paid_on: z.string().optional().describe('Payment date for pay event (YYYY-MM-DD)'),
  paid_amount: z.number().optional().describe('Partial payment amount (for pay_partial_proforma)'),
});

export const SearchInvoicesSchema = z.object({
  query: z.string().min(1).describe('Search query (searches invoice number, subject name, etc.)'),
  page: z.number().int().positive().optional().describe('Page number'),
  tags: z.array(z.string()).optional().describe('Filter by tags'),
});

// ── Invoice Delete ────────────────────────────────────────────────

export const DeleteInvoiceSchema = z.object({
  id: z.number().int().positive().describe('Invoice ID'),
});

// ── Invoice Payments ──────────────────────────────────────────────

export const CreatePaymentSchema = z.object({
  id: z.number().int().positive().describe('Invoice ID'),
  paid_on: z.string().optional().describe('Payment date (YYYY-MM-DD, default: today)'),
  amount: z.number().optional().describe('Payment amount (default: remaining amount)'),
  native_amount: z.number().optional().describe('Payment amount in account currency'),
  currency: z.string().optional().describe('Currency code (e.g., "CZK", "EUR")'),
  bank_account_id: z.number().int().positive().optional().describe('Bank account ID'),
  mark_document_as_paid: z
    .boolean()
    .optional()
    .describe('Mark document as paid (default: true if total paid >= remaining)'),
  variable_symbol: z.string().optional().describe('Payment variable symbol'),
});

export const DeletePaymentSchema = z.object({
  invoice_id: z.number().int().positive().describe('Invoice ID'),
  payment_id: z.number().int().positive().describe('Payment ID'),
});

// ── Invoice Messages ──────────────────────────────────────────────

export const SendInvoiceMessageSchema = z.object({
  id: z.number().int().positive().describe('Invoice ID'),
  email: z.string().describe('Recipient email address'),
  subject: z.string().optional().describe('Email subject'),
  message: z.string().optional().describe('Email message body'),
});
