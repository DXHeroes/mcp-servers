/**
 * Fakturoid tool definitions: the money coming in.
 *
 * Account lookups (account, users, bank accounts), invoices and their payments
 * and messages, and the subjects (contacts) those documents are issued to.
 */

import { z } from 'zod';
import type { FakturoidClient } from './client.js';
import {
  CreateInvoiceSchema,
  CreatePaymentSchema,
  CreateSubjectSchema,
  DeleteInvoiceSchema,
  DeletePaymentSchema,
  DeleteSubjectSchema,
  EmptySchema,
  GetInvoiceSchema,
  GetSubjectSchema,
  InvoiceActionSchema,
  ListInvoicesSchema,
  ListSubjectsSchema,
  SearchInvoicesSchema,
  SearchSubjectsSchema,
  SendInvoiceMessageSchema,
  UpdateInvoiceSchema,
  UpdateSubjectSchema,
} from './schemas.js';
import { DESTRUCTIVE_TOOL, READ_ONLY_TOOL, type ToolDef, WRITE_TOOL } from './tool-annotations.js';

export function buildInvoicingToolDefs(c: FakturoidClient): ToolDef[] {
  return [
    // ── Account ──────────────────────────────────────────────────
    {
      name: 'fakturoid_get_account',
      description: 'Get Fakturoid account details (plan, owner, settings).',
      inputSchema: EmptySchema,
      annotations: READ_ONLY_TOOL,
      handler: () => c.getAccount(),
    },

    // ── Users & Bank Accounts ─────────────────────────────────────
    {
      name: 'fakturoid_list_users',
      description: 'List all users in the Fakturoid account.',
      inputSchema: EmptySchema,
      annotations: READ_ONLY_TOOL,
      handler: () => c.listUsers(),
    },
    {
      name: 'fakturoid_list_bank_accounts',
      description: 'List all bank accounts configured in the Fakturoid account.',
      inputSchema: EmptySchema,
      annotations: READ_ONLY_TOOL,
      handler: () => c.listBankAccounts(),
    },

    // ── Invoices ─────────────────────────────────────────────────
    {
      name: 'fakturoid_list_invoices',
      description:
        'List invoices with optional filtering by status, subject, date, or invoice number. Returns 40 items per page.',
      inputSchema: ListInvoicesSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listInvoices(args as z.infer<typeof ListInvoicesSchema>),
    },
    {
      name: 'fakturoid_get_invoice',
      description: 'Get full details of a specific invoice by ID, including line items.',
      inputSchema: GetInvoiceSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.getInvoice(args as z.infer<typeof GetInvoiceSchema>),
    },
    {
      name: 'fakturoid_create_invoice',
      description:
        'Create a new invoice with line items. Requires subject_id and at least one line item with name and unit_price.',
      inputSchema: CreateInvoiceSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createInvoice(args as Record<string, unknown>),
    },
    {
      name: 'fakturoid_update_invoice',
      description:
        'DESTRUCTIVE: overwrites the fields you pass on an existing invoice. This client cannot read a ' +
        "previous version back, so from a caller's point of view the note, dates, prices or subject " +
        'the invoice carried before are gone — read it with fakturoid_get_invoice first if the old ' +
        'value matters, and pass only the fields you mean to change. Passing lines replaces the whole ' +
        'line set rather than editing one row, so a line you want to keep has to be sent again. This is ' +
        'still usually the right way to fix a wrong invoice: fakturoid_delete_invoice works only on ' +
        'drafts and frees the document number for reuse. Fakturoid answers 403 if the document is ' +
        'locked — unlock it with fakturoid_invoice_action first.',
      inputSchema: UpdateInvoiceSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => {
        const { id, ...data } = args as z.infer<typeof UpdateInvoiceSchema>;
        return c.updateInvoice({ id }, data);
      },
    },
    {
      name: 'fakturoid_invoice_action',
      description:
        'DESTRUCTIVE: fires a state change on an invoice, and the events are not all reversible. cancel ' +
        'voids the document, remove_payment drops a recorded payment, and deliver and deliver_reminder ' +
        'send a real email to the customer that cannot be recalled; others (undo_cancel, unlock, ' +
        'undo_uncollectible) exist precisely to reverse their counterparts. Read the invoice with ' +
        'fakturoid_get_invoice first and pass exactly one event: mark_as_sent, deliver, pay, ' +
        'pay_proforma, pay_partial_proforma, remove_payment, deliver_reminder, cancel, undo_cancel, ' +
        'lock, unlock, mark_as_uncollectible, undo_uncollectible.',
      inputSchema: InvoiceActionSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => c.invoiceAction(args as z.infer<typeof InvoiceActionSchema>),
    },
    {
      name: 'fakturoid_search_invoices',
      description: 'Full-text search invoices by number, subject name, or note.',
      inputSchema: SearchInvoicesSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.searchInvoices(args as z.infer<typeof SearchInvoicesSchema>),
    },
    {
      name: 'fakturoid_delete_invoice',
      description:
        'DESTRUCTIVE: deletes an invoice. Only drafts can be deleted, and Fakturoid answers 422 when ' +
        'the document is anchored to another one (a proforma with a paid invoice attached, an invoice ' +
        'with a correction invoice, a proforma with tax documents). Deleting releases the document ' +
        'number for reuse. The Fakturoid web app documents an undo right after a deletion and a trash ' +
        'on paid plans, but the API exposes no restore endpoint and this tool set has none, so from ' +
        'here it cannot be undone. To correct an invoice instead of removing it, use ' +
        'fakturoid_update_invoice, or fakturoid_invoice_action with cancel for a document already ' +
        'issued.',
      inputSchema: DeleteInvoiceSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => c.deleteInvoice(args as z.infer<typeof DeleteInvoiceSchema>),
    },

    // ── Invoice Payments ──────────────────────────────────────────
    {
      name: 'fakturoid_create_payment',
      description:
        'Record a payment against an invoice. Additive: it creates a payment record, and ' +
        'fakturoid_delete_payment removes it again. Fakturoid answers 403 when the invoice is already ' +
        'paid, and when the account has no bank account configured.',
      inputSchema: CreatePaymentSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createPayment(args as z.infer<typeof CreatePaymentSchema>),
    },
    {
      name: 'fakturoid_delete_payment',
      description:
        'DESTRUCTIVE: removes a recorded payment from an invoice, which also takes the invoice back out ' +
        'of its paid state. There is no restore endpoint for a payment — re-recording it with ' +
        'fakturoid_create_payment produces a new record, not the one that was removed. Read the invoice ' +
        'with fakturoid_get_invoice first to confirm which payment_id you mean.',
      inputSchema: DeletePaymentSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => c.deletePayment(args as z.infer<typeof DeletePaymentSchema>),
    },

    // ── Invoice Messages ──────────────────────────────────────────
    {
      name: 'fakturoid_send_invoice_message',
      description:
        'DESTRUCTIVE: sends a real email carrying the invoice to the address passed in. It reaches a ' +
        'third party and cannot be recalled or corrected afterwards, and the recipient comes from this ' +
        "argument rather than from the invoice's subject, so a wrong address delivers the document to " +
        'whoever owns it. Confirm the invoice with fakturoid_get_invoice and the address with ' +
        'fakturoid_get_subject before calling. To record that an invoice was sent without actually ' +
        'sending anything, use fakturoid_invoice_action with mark_as_sent.',
      inputSchema: SendInvoiceMessageSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => c.sendInvoiceMessage(args as z.infer<typeof SendInvoiceMessageSchema>),
    },

    // ── Subjects (Contacts) ─────────────────────────────────────
    {
      name: 'fakturoid_list_subjects',
      description: 'List subjects (contacts/companies). Returns 40 items per page.',
      inputSchema: ListSubjectsSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listSubjects(args as z.infer<typeof ListSubjectsSchema>),
    },
    {
      name: 'fakturoid_get_subject',
      description: 'Get full details of a specific subject/contact by ID.',
      inputSchema: GetSubjectSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.getSubject(args as z.infer<typeof GetSubjectSchema>),
    },
    {
      name: 'fakturoid_create_subject',
      description:
        'Create a new subject/contact. Supports Czech business fields (ICO, DIC, bank account, IBAN).',
      inputSchema: CreateSubjectSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createSubject(args as Record<string, unknown>),
    },
    {
      name: 'fakturoid_search_subjects',
      description: 'Search subjects by name, registration number (ICO), or other fields.',
      inputSchema: SearchSubjectsSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.searchSubjects(args as z.infer<typeof SearchSubjectsSchema>),
    },
    {
      name: 'fakturoid_update_subject',
      description:
        'DESTRUCTIVE: overwrites the fields you pass on an existing subject/contact. This client cannot ' +
        'read a previous version back, so the earlier name, address, registration numbers (ICO/DIC) or ' +
        "bank details are gone from a caller's point of view — read the subject with " +
        'fakturoid_get_subject first and pass only the fields you mean to change. Whether documents ' +
        'already issued keep the details copied onto them at issue time is not verified here; check one ' +
        'with fakturoid_get_invoice if it matters. It is still much safer than ' +
        'fakturoid_delete_subject, and renaming a contact is the recommended way to retire one.',
      inputSchema: UpdateSubjectSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => {
        const { id, ...data } = args as z.infer<typeof UpdateSubjectSchema>;
        return c.updateSubject({ id }, data);
      },
    },
    {
      name: 'fakturoid_delete_subject',
      description:
        "DESTRUCTIVE: deletes a subject/contact. Fakturoid's own support material advises against " +
        'deleting contacts, because a contact is referenced by every document ever issued to it, and ' +
        'there is no restore endpoint here. If the goal is to stop using a contact, leave it in place ' +
        'or mark it with fakturoid_update_subject rather than deleting it.',
      inputSchema: DeleteSubjectSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => c.deleteSubject(args as z.infer<typeof DeleteSubjectSchema>),
    },
  ];
}
