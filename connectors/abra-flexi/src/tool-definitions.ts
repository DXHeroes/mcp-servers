/**
 * Abra Flexi tool definitions.
 *
 * The full 30-tool table handed to `FlexiMcpServer`: account info, issued and
 * received invoices, contacts, bank statements, products, orders, cash and
 * stock movements, internal documents, and the generic record tools.
 */

import { z } from 'zod';
import type { FlexiClient } from './client.js';
import {
  CreateContactSchema,
  CreateInternalDocumentSchema,
  CreateIssuedInvoiceSchema,
  CreateOrderIssuedSchema,
  CreateOrderReceivedSchema,
  CreateProductSchema,
  CreateReceivedInvoiceSchema,
  CreateRecordSchema,
  DeleteRecordSchema,
  EmptySchema,
  GetContactSchema,
  GetIssuedInvoiceSchema,
  GetReceivedInvoiceSchema,
  GetRecordSchema,
  ListBankStatementsSchema,
  ListCashMovementsSchema,
  ListContactsSchema,
  ListInternalDocumentsSchema,
  ListIssuedInvoicesSchema,
  ListOrdersIssuedSchema,
  ListOrdersReceivedSchema,
  ListProductsSchema,
  ListReceivedInvoicesSchema,
  ListRecordsSchema,
  ListStockMovementsSchema,
  UpdateContactSchema,
  UpdateIssuedInvoiceSchema,
  UpdateProductSchema,
  UpdateReceivedInvoiceSchema,
  UpdateRecordSchema,
} from './schemas.js';
import { DESTRUCTIVE_TOOL, READ_ONLY_TOOL, type ToolDef, WRITE_TOOL } from './tool-annotations.js';

export function buildFlexiToolDefs(c: FlexiClient): ToolDef[] {
  return [
    // ── Account ──────────────────────────────────────────────────
    {
      name: 'flexi_get_account_info',
      description: 'Get Flexi company/account information (name, IC, DIC, address, settings).',
      inputSchema: EmptySchema,
      annotations: READ_ONLY_TOOL,
      handler: () => c.getAccountInfo(),
    },

    // ── Issued Invoices (faktura-vydana) ─────────────────────────
    {
      name: 'flexi_list_issued_invoices',
      description:
        'List issued invoices (faktury vydane). Supports filtering, pagination, and sorting.',
      inputSchema: ListIssuedInvoicesSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listIssuedInvoices(args as z.infer<typeof ListIssuedInvoicesSchema>),
    },
    {
      name: 'flexi_get_issued_invoice',
      description: 'Get details of a specific issued invoice by ID or code.',
      inputSchema: GetIssuedInvoiceSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => {
        const { id } = args as z.infer<typeof GetIssuedInvoiceSchema>;
        return c.getIssuedInvoice(id);
      },
    },
    {
      name: 'flexi_create_issued_invoice',
      description:
        'Create a new issued invoice (faktura vydana). Fields use Czech names: firma (contact), datVyst (issue date), polozkyFaktury (line items).',
      inputSchema: CreateIssuedInvoiceSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createIssuedInvoice(args as Record<string, unknown>),
    },
    {
      name: 'flexi_update_issued_invoice',
      description:
        'DESTRUCTIVE: overwrites fields on an existing issued invoice (faktura vydana), by ID or code. Only the fields you pass are changed, but each one replaces its previous value and the REST API offers no way to read the old value back, so treat the overwrite as unrecoverable. An issued invoice may already be posted or sent to the customer, so read it with flexi_get_issued_invoice before changing it.',
      inputSchema: UpdateIssuedInvoiceSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => {
        const { id, ...data } = args as z.infer<typeof UpdateIssuedInvoiceSchema>;
        return c.updateIssuedInvoice(id, data as Record<string, unknown>);
      },
    },

    // ── Received Invoices (faktura-prijata) ──────────────────────
    {
      name: 'flexi_list_received_invoices',
      description:
        'List received invoices (faktury prijate). Supports filtering, pagination, and sorting.',
      inputSchema: ListReceivedInvoicesSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listReceivedInvoices(args as z.infer<typeof ListReceivedInvoicesSchema>),
    },
    {
      name: 'flexi_get_received_invoice',
      description: 'Get details of a specific received invoice by ID or code.',
      inputSchema: GetReceivedInvoiceSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => {
        const { id } = args as z.infer<typeof GetReceivedInvoiceSchema>;
        return c.getReceivedInvoice(id);
      },
    },
    {
      name: 'flexi_create_received_invoice',
      description: 'Create a new received invoice (faktura prijata) from a supplier.',
      inputSchema: CreateReceivedInvoiceSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createReceivedInvoice(args as Record<string, unknown>),
    },
    {
      name: 'flexi_update_received_invoice',
      description:
        'DESTRUCTIVE: overwrites fields on an existing received invoice (faktura prijata), by ID or code. Only the fields you pass are changed, but each one replaces its previous value and the REST API offers no way to read the old value back, so treat the overwrite as unrecoverable. Received invoices carry the supplier data the accounting is built on, so read it with flexi_get_received_invoice before changing it.',
      inputSchema: UpdateReceivedInvoiceSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => {
        const { id, ...data } = args as z.infer<typeof UpdateReceivedInvoiceSchema>;
        return c.updateReceivedInvoice(id, data as Record<string, unknown>);
      },
    },

    // ── Contacts (adresar) ──────────────────────────────────────
    {
      name: 'flexi_list_contacts',
      description:
        'List contacts from the address book (adresar). Supports filtering by name, IC, etc.',
      inputSchema: ListContactsSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listContacts(args as z.infer<typeof ListContactsSchema>),
    },
    {
      name: 'flexi_get_contact',
      description: 'Get details of a specific contact by ID or code.',
      inputSchema: GetContactSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => {
        const { id } = args as z.infer<typeof GetContactSchema>;
        return c.getContact(id);
      },
    },
    {
      name: 'flexi_create_contact',
      description:
        'Create a new contact in the address book. Fields use Czech names: nazev (name), ulice (street), ic (ICO), dic (DIC).',
      inputSchema: CreateContactSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createContact(args as Record<string, unknown>),
    },
    {
      name: 'flexi_update_contact',
      description:
        'DESTRUCTIVE: overwrites fields on an existing contact in the address book (adresar), by ID or code. Only the fields you pass are changed, but each one replaces its previous value and the REST API offers no way to read the old value back, so treat the overwrite as unrecoverable. The contact may be referenced by existing invoices and orders; read it with flexi_get_contact first.',
      inputSchema: UpdateContactSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => {
        const { id, ...data } = args as z.infer<typeof UpdateContactSchema>;
        return c.updateContact(id, data as Record<string, unknown>);
      },
    },

    // ── Bank Statements (banka) ─────────────────────────────────
    {
      name: 'flexi_list_bank_statements',
      description: 'List bank statement records (banka). Supports filtering and pagination.',
      inputSchema: ListBankStatementsSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listBankStatements(args as z.infer<typeof ListBankStatementsSchema>),
    },

    // ── Products (cenik) ────────────────────────────────────────
    {
      name: 'flexi_list_products',
      description: 'List products from the price list (cenik). Supports filtering and pagination.',
      inputSchema: ListProductsSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listProducts(args as z.infer<typeof ListProductsSchema>),
    },
    {
      name: 'flexi_create_product',
      description:
        'Create a new product in the price list. Fields use Czech names: kod (code), nazev (name), cenaBezDph (price excl. VAT).',
      inputSchema: CreateProductSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createProduct(args as Record<string, unknown>),
    },
    {
      name: 'flexi_update_product',
      description:
        'DESTRUCTIVE: overwrites fields on an existing product in the price list (cenik), by ID or code. Only the fields you pass are changed, but each one replaces its previous value and the REST API offers no way to read the old value back, so treat the overwrite as unrecoverable. Read the product with flexi_list_products (filtered by code) before changing a price.',
      inputSchema: UpdateProductSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => {
        const { id, ...data } = args as z.infer<typeof UpdateProductSchema>;
        return c.updateProduct(id, data as Record<string, unknown>);
      },
    },

    // ── Orders Received (objednavka-prijata) ──────────────────────
    {
      name: 'flexi_list_orders_received',
      description:
        'List received orders (objednavky prijate). Supports filtering, pagination, and sorting.',
      inputSchema: ListOrdersReceivedSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listOrdersReceived(args as z.infer<typeof ListOrdersReceivedSchema>),
    },
    {
      name: 'flexi_create_order_received',
      description:
        'Create a new received order (objednavka prijata). Fields: firma (contact), datObj (order date), polozkyObjednavky (line items).',
      inputSchema: CreateOrderReceivedSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createOrderReceived(args as Record<string, unknown>),
    },

    // ── Orders Issued (objednavka-vydana) ─────────────────────────
    {
      name: 'flexi_list_orders_issued',
      description:
        'List issued orders (objednavky vydane). Supports filtering, pagination, and sorting.',
      inputSchema: ListOrdersIssuedSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listOrdersIssued(args as z.infer<typeof ListOrdersIssuedSchema>),
    },
    {
      name: 'flexi_create_order_issued',
      description:
        'Create a new issued order (objednavka vydana). Fields: firma (contact), datObj (order date), polozkyObjednavky (line items).',
      inputSchema: CreateOrderIssuedSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createOrderIssued(args as Record<string, unknown>),
    },

    // ── Cash Movements (pokladni-pohyb) ───────────────────────────
    {
      name: 'flexi_list_cash_movements',
      description:
        'List cash register movements (pokladni pohyby). Supports filtering and pagination.',
      inputSchema: ListCashMovementsSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listCashMovements(args as z.infer<typeof ListCashMovementsSchema>),
    },

    // ── Internal Documents (interni-doklad) ───────────────────────
    {
      name: 'flexi_list_internal_documents',
      description: 'List internal documents (interni doklady). Supports filtering and pagination.',
      inputSchema: ListInternalDocumentsSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) =>
        c.listInternalDocuments(args as z.infer<typeof ListInternalDocumentsSchema>),
    },
    {
      name: 'flexi_create_internal_document',
      description:
        'Create a new internal document (interni doklad). Fields: typDokl (type), datVyst (date), polozkyIntDokl (line items with nazev, castka, ucet).',
      inputSchema: CreateInternalDocumentSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createInternalDocument(args as Record<string, unknown>),
    },

    // ── Stock Movements (skladovy-pohyb) ──────────────────────────
    {
      name: 'flexi_list_stock_movements',
      description:
        'List stock/inventory movements (skladove pohyby). Supports filtering and pagination.',
      inputSchema: ListStockMovementsSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listStockMovements(args as z.infer<typeof ListStockMovementsSchema>),
    },

    // ── Generic Records ─────────────────────────────────────────
    {
      name: 'flexi_list_records',
      description:
        'Generic tool to list records from any Flexi evidence (endpoint). Use this for endpoints not covered by specific tools, e.g., "objednavka-prijata" (orders), "pokladna" (cash register), "strom" (tree), etc.',
      inputSchema: ListRecordsSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => {
        const { evidence, ...params } = args as z.infer<typeof ListRecordsSchema>;
        return c.listRecords(evidence, params);
      },
    },
    {
      name: 'flexi_get_record',
      description: 'Generic tool to get a single record from any Flexi evidence by ID or code.',
      inputSchema: GetRecordSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => {
        const { evidence, id } = args as z.infer<typeof GetRecordSchema>;
        return c.getRecord(evidence, id);
      },
    },
    {
      name: 'flexi_create_record',
      description:
        'Generic tool to create a record in any Flexi evidence. Pass evidence name and data object.',
      inputSchema: CreateRecordSchema,
      annotations: WRITE_TOOL,
      handler: (args) => {
        const { evidence, data } = args as z.infer<typeof CreateRecordSchema>;
        return c.createRecord(evidence, data);
      },
    },
    {
      name: 'flexi_update_record',
      description:
        'DESTRUCTIVE: overwrites fields on a record in ANY Flexi evidence, by ID or code. Pass the evidence name, the id, and a data object with the fields to change. Only the fields you pass are changed, but each one replaces its previous value and the REST API offers no way to read the old value back, so treat the overwrite as unrecoverable. Because the evidence is a parameter, the scope of the change is whatever that evidence holds — an address-book entry, an invoice, an accounting document — and this tool cannot tell you what a write means in the evidence you picked. Read the record first with flexi_get_record.',
      inputSchema: UpdateRecordSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => {
        const { evidence, id, data } = args as z.infer<typeof UpdateRecordSchema>;
        return c.updateRecord(evidence, id, data);
      },
    },
    {
      name: 'flexi_delete_record',
      description:
        'DESTRUCTIVE: permanently deletes a record from ANY Flexi evidence, by ID or code. The REST API has no undo. Because the evidence is a parameter, the scope of the damage is whatever that evidence holds, and what Flexi does with records that reference the deleted one — an invoice pointing at a contact, a line item pointing at a product — depends on the evidence and on how the instance is configured. This tool cannot promise anything about that, so treat the outcome as requested rather than guaranteed and verify afterwards with flexi_get_record. Where the evidence has a cancellation or hidden flag, setting it with flexi_update_record retires the record without deleting it.',
      inputSchema: DeleteRecordSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => {
        const { evidence, id } = args as z.infer<typeof DeleteRecordSchema>;
        return c.deleteRecord(evidence, id);
      },
    },
  ];
}
