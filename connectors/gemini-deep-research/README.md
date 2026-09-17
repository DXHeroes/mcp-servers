# Gemini Deep Research connector

Long-running cited web research through Google's Deep Research Agent.

## Credential and deployment

Use a Gemini API key from Google AI Studio as `MCP_UPSTREAM_CREDENTIAL[_FILE]`, with a distinct
connector `MCP_ACCESS_TOKEN[_FILE]`. The key's Google project must have access and billing suitable
for Deep Research. Catalog delivery is `connector_base64url` for shared or per-user mode.

```sh
docker build -f Dockerfile.connector --build-arg CONNECTOR=gemini-deep-research -t mcp-gemini .
docker run --rm -p 127.0.0.1:8080:8080 \
  -e MCP_ACCESS_TOKEN -e MCP_UPSTREAM_CREDENTIAL \
  -e MCP_ALLOWED_HOSTS=localhost,127.0.0.1 mcp-gemini
```

## MCP surface

- `deep_research`: starts research for a detailed topic.
- `deep_research_followup`: asks a follow-up using a prior interaction ID.

No resources or prompts are exposed. Calls create billable provider work. Follow-up uses the Gemini
2.5 Pro model with the prior interaction ID, so it is a linked, billable model follow-up rather than
another Deep Research Agent run. Both tools carry read-only annotations because they return
informational results; those protocol hints do not change provider billing.

## Limits and troubleshooting

Research typically takes 5–20 minutes and the connector enforces a finite 60-minute ceiling.
Progress is sent only when the MCP caller supplies a progress token. Cancellation aborts active
HTTP/polling and attempts a separately bounded provider cancellation after an interaction ID is
known; provider work may continue if that attempt fails. Do not start a duplicate topic immediately
after a timeout because the original may still be running and charging upstream. Clients need their
own finite timeout longer than expected research and must close/abort abandoned transports.
