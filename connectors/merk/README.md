# Merk connector

Read-only Czech and Slovak company intelligence through the Merk API.

## Credential and deployment

Provision a Merk API token as `MCP_UPSTREAM_CREDENTIAL[_FILE]` and a distinct service bearer as
`MCP_ACCESS_TOKEN[_FILE]`. The Merk subscription controls accessible datasets, credits and rate
limits.

```sh
docker build -f Dockerfile.connector --build-arg CONNECTOR=merk -t mcp-merk .
docker run --rm -p 127.0.0.1:8080:8080 \
  -e MCP_ACCESS_TOKEN -e MCP_UPSTREAM_CREDENTIAL \
  -e MCP_ALLOWED_HOSTS=localhost,127.0.0.1 mcp-merk
```

## MCP surface

All tools are read-only; no resources or prompts are exposed:

- Company lookup/search: `merk_company_lookup`, `merk_company_batch`, `merk_company_suggest`,
  `merk_search_companies`, `merk_new_companies`, `merk_updated_companies`.
- Finance/operations: `merk_financial_statements`, `merk_financial_indicators`,
  `merk_company_employees`, `merk_company_fleet`, `merk_company_fleet_stats`,
  `merk_company_business_premises`, `merk_company_licenses`, `merk_company_events`,
  `merk_company_job_ads`, `merk_company_gov_contracts`.
- Relations: `merk_relations_company`, `merk_relations_person`,
  `merk_relations_search_person`, `merk_relations_shortest_path`.
- Reference/account: `merk_enums`, `merk_subscription_info`, `merk_vokativ`.

## Limits and troubleshooting

Fields and datasets depend on country, subscription and upstream availability. Use
`merk_subscription_info` to inspect plan/credit information and `merk_enums` for accepted enum
values. Pagination is explicit where offered; avoid broad searches when a company ID is known.
Authorization failures can mean the plan lacks a dataset. Treat upstream company data as evidence
to verify, not a legal or financial conclusion.
