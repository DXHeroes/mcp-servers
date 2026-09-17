# Fakturoid connector

MCP tools for Fakturoid API v3 invoicing, subjects, expenses, inventory and account data.

## Credential and deployment

The raw credential format is `account_slug:client_id:client_secret`. Create OAuth client credentials
under Fakturoid account settings; the slug is the account subdomain. This is a client-credentials
triple carried through the connector credential channel, not a gateway OAuth flow. Provision it as
`MCP_UPSTREAM_CREDENTIAL[_FILE]` and use a distinct `MCP_ACCESS_TOKEN[_FILE]` for the service.

```sh
docker build -f Dockerfile.connector --build-arg CONNECTOR=fakturoid -t mcp-fakturoid .
docker run --rm -p 127.0.0.1:8080:8080 \
  -e MCP_ACCESS_TOKEN -e MCP_UPSTREAM_CREDENTIAL \
  -e MCP_ALLOWED_HOSTS=localhost,127.0.0.1 mcp-fakturoid
```

The OAuth client needs only the Fakturoid account permissions required by enabled tools.

## MCP surface

No resources or prompts are exposed. Tools are grouped below:

- Account: `fakturoid_get_account`, `fakturoid_list_users`,
  `fakturoid_list_bank_accounts`, `fakturoid_list_number_formats`, `fakturoid_list_tags`.
- Invoices/payments: `fakturoid_list_invoices`, `fakturoid_get_invoice`,
  `fakturoid_search_invoices`, `fakturoid_create_invoice`, `fakturoid_update_invoice`,
  `fakturoid_delete_invoice`, `fakturoid_invoice_action`, `fakturoid_create_payment`,
  `fakturoid_delete_payment`, `fakturoid_send_invoice_message`.
- Subjects: `fakturoid_list_subjects`, `fakturoid_get_subject`, `fakturoid_search_subjects`,
  `fakturoid_create_subject`, `fakturoid_update_subject`, `fakturoid_delete_subject`.
- Expenses: `fakturoid_list_expenses`, `fakturoid_get_expense`, `fakturoid_search_expenses`,
  `fakturoid_create_expense`, `fakturoid_update_expense`, `fakturoid_delete_expense`,
  `fakturoid_expense_action`, `fakturoid_create_expense_payment`,
  `fakturoid_delete_expense_payment`.
- Inventory: `fakturoid_list_inventory_items`, `fakturoid_get_inventory_item`,
  `fakturoid_search_inventory_items`, `fakturoid_create_inventory_item`,
  `fakturoid_update_inventory_item`, `fakturoid_list_inventory_moves`,
  `fakturoid_create_inventory_move`.
- Automation: `fakturoid_list_generators`, `fakturoid_get_generator`,
  `fakturoid_create_generator`, `fakturoid_list_recurring_generators`,
  `fakturoid_get_recurring_generator`, `fakturoid_list_events`, `fakturoid_list_todos`,
  `fakturoid_toggle_todo`.

List/get/search tools are read-only. Create, update, action, send, payment, toggle and delete tools
mutate accounting data; irreversible deletes and overwrites are annotated destructive and should
require approval.

## Limits and troubleshooting

Fakturoid rate-limit headers determine the actual account window. Wait for reset on 429. A 403 can
mean a locked document, missing bank account, subject limit or an already paid invoice rather than a
bad credential. Dates must use the API's ISO 8601 formats. Empty successful write responses are
reported as outcomes to verify; do not blindly repeat a payment or write.
