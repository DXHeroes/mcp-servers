# Abra Flexi connector

MCP access to Abra Flexi invoices, contacts, products, orders and accounting records.

## Credential and deployment

The upstream credential is one raw string:
`https://server/c/company|username:password`. The URL must already include `/c/<company>`.
Provision it as `MCP_UPSTREAM_CREDENTIAL[_FILE]`; provision the unrelated connector bearer as
`MCP_ACCESS_TOKEN[_FILE]`. The catalog delivers personal credentials with
`connector_base64url`. The Flexi user needs REST API access and rights for each requested evidence;
HTTP 403 can also mean a license/concurrent-user limit.

```sh
docker build -f Dockerfile.connector --build-arg CONNECTOR=abra-flexi -t mcp-abra-flexi .
docker run --rm -p 127.0.0.1:8080:8080 \
  -e MCP_ACCESS_TOKEN -e MCP_UPSTREAM_CREDENTIAL \
  -e MCP_ALLOWED_HOSTS=localhost,127.0.0.1 mcp-abra-flexi
```

Abra deployments are commonly private. Private targets are allowed unless
`MCP_ALLOW_PRIVATE_NETWORK_TARGETS=false`; link-local and unspecified ranges remain blocked and
redirects are revalidated. Restrict container egress to approved Flexi networks.

## Company-scoped invoice reader

Set `FLEXI_INVOICE_READER_COMPANY_URL` on a dedicated connector process to the exact HTTPS
company URL in the credential. HTTP on 127.0.0.1 with an explicit port is supported for local
fixtures. The process rejects mismatched credentials and redirects. Use a REST user with read
permission for just the two invoice registers in this company. Leaving the variable unset
selects the existing 30-tool profile.

The reader exposes only the four issued/received invoice list/get tools. Lists accept
`limit` (1–500, default 50), `start` (default 0) and an optional exact numeric filter
such as `id = 123`. Results are sorted by ID. Detail accepts a positive numeric ID.
Both return an array under the Flexi evidence name. The field allowlist is `id`, `kod`,
`mena`, `sumCelkem` (domestic total), `sumCelkemMen` (foreign total), `cisObj` (order
number), `varSym` (variable symbol) and, for received invoices, `cisDosle` (supplier
invoice number). Projection also applies when Flexi includes descriptions or line items.
Missing optional fields remain absent. Malformed rows fail the call.

Run `pnpm build && pnpm --filter @dxheroes/mcp-abra-flexi test` from the workspace root for
the local stdio/HTTP fixture. For read-only provider verification, inject the scoped URL and
`MCP_UPSTREAM_CREDENTIAL` into the environment. Set `FLEXI_ISSUED_SAMPLE_ID`,
`FLEXI_RECEIVED_SAMPLE_ID` to known synthetic IDs and `FLEXI_MISSING_ID` to an unused
numeric ID. Run `node connectors/abra-flexi/scripts/verify-reader.mjs` from the root.
The script reports skipped sample checks and compares API and MCP responses in memory.
A Gateway built-in connector is a separate implementation and requires separate acceptance.

In the full profile, invoice creates accept an optional stable external `id` in
`ext:system:key` format. Supply the same ID on retry and read back the invoice before
retrying a write with an unknown outcome.

## MCP surface

No resources or prompts are exposed. Tools:

- Account: `flexi_get_account_info`.
- Issued/received invoices: `flexi_list_issued_invoices`, `flexi_get_issued_invoice`,
  `flexi_create_issued_invoice`, `flexi_update_issued_invoice`,
  `flexi_list_received_invoices`, `flexi_get_received_invoice`,
  `flexi_create_received_invoice`, `flexi_update_received_invoice`.
- Contacts/products: `flexi_list_contacts`, `flexi_get_contact`, `flexi_create_contact`,
  `flexi_update_contact`, `flexi_list_products`, `flexi_create_product`, `flexi_update_product`.
- Accounting reads: `flexi_list_bank_statements`, `flexi_list_cash_movements`,
  `flexi_list_internal_documents`, `flexi_list_stock_movements`.
- Orders/documents: `flexi_list_orders_received`, `flexi_create_order_received`,
  `flexi_list_orders_issued`, `flexi_create_order_issued`, `flexi_create_internal_document`.
- Generic evidence: `flexi_list_records`, `flexi_get_record`, `flexi_create_record`,
  `flexi_update_record`, `flexi_delete_record`.

List/get tools are annotated read-only. Create tools mutate Flexi. Update tools overwrite supplied
fields without history, and generic delete permanently removes the selected evidence record; those
tools are destructive hints and should require gateway approval. An annotation is not enforcement.

## Limits and troubleshooting

Tool calls have a 20-second deadline. If a write times out, check the record before retrying.

List operations support the filters/pagination accepted by their schemas. Generic evidence tools
can touch data beyond the named convenience tools, so restrict them when users do not need that
scope. A 401 means rejected username/password; 402 usually means REST writes are not licensed; 403
can be permissions or license capacity. Verify the company path, rights and active sessions before
rotating a valid credential.

## Invoice creation profile

Set `FLEXI_INVOICE_CREATOR_COMPANY_URL` to the exact company URL to expose the
four invoice reads and two create tools. When both profile variables are set,
the reader takes precedence. Creation requires a document type and a stable
external ID. Keep that ID across retries. Flexi receives the per-document
`@update: fail` import mode and rejects attempts to overwrite existing invoices.
The connector checks the import statistics before confirming creation. Use a
company-scoped API account with invoice creation rights and without lock-management
rights. Validate the accounting period and document lock rules in a write-approved
test company before enabling this profile.
