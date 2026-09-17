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

List operations support the filters/pagination accepted by their schemas. Generic evidence tools
can touch data beyond the named convenience tools, so restrict them when users do not need that
scope. A 401 means rejected username/password; 402 usually means REST writes are not licensed; 403
can be permissions or license capacity. Verify the company path, rights and active sessions before
rotating a valid credential.
