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

No resources or prompts are exposed. Research uses `deep-research-preview-04-2026`.
Follow-up uses `gemini-3.8-flash` with the prior interaction ID. Both tools create billable
provider work and carry read-only annotations for their informational results. The connector
submits one request per follow-up and surfaces provider errors or incomplete results.
Google estimates $1-3 for a typical research task. [Deep Research pricing](https://aistudio.google.com/docs/deep-research#estimated-costs)

Stored interaction IDs remain tied to the issuing Gemini project and Google's retention period.
The connector forwards the original ID for follow-ups and can read older research responses
that still use the legacy output format.

## Limits and troubleshooting

Research typically takes 5–20 minutes and the connector enforces a finite 60-minute ceiling.
Progress is sent only when the MCP caller supplies a progress token. Cancellation aborts active
HTTP/polling and attempts a separately bounded provider cancellation after an interaction ID is
known; provider work may continue if that attempt fails. Do not start a duplicate topic immediately
after a timeout because the original may still be running and charging upstream. Clients need their
own finite timeout longer than expected research and must close/abort abandoned transports.
