# ByzData connector

Read-only Czech company data assembled from ARES, Justice.cz and ISIR.

## Credential and deployment

No upstream credential is required. The MCP transport still requires a separately provisioned
`MCP_ACCESS_TOKEN[_FILE]`; catalog auth is `none` in shared mode.

```sh
docker build -f Dockerfile.connector --build-arg CONNECTOR=byzdata -t mcp-byzdata .
docker run --rm -p 127.0.0.1:8080:8080 -e MCP_ACCESS_TOKEN \
  -e MCP_ALLOWED_HOSTS=localhost,127.0.0.1 mcp-byzdata
```

## MCP surface

All nine tools are read-only:

- `search_company`, `get_company`, `get_company_details`
- `get_company_relations`, `find_related_companies`
- `get_company_documents`, `get_company_extract`
- `check_insolvency`, `check_company_health`

Three templated Markdown resources accept a Czech company registration number (`ico`):
`company://{ico}/overview`, `company://{ico}/relations`, and
`company://{ico}/documents`. No prompts are exposed.

## Limits and troubleshooting

Results reflect public upstream registries and can be incomplete, delayed, unavailable or
inconsistent between sources. Health assessment is derived guidance, not legal, credit or
insolvency advice. Validate important conclusions against the named public register. A not-found
result can mean an invalid ICO or a temporary upstream gap. Retry rate-limited/transient responses
later; do not turn them into a positive company-health claim.
