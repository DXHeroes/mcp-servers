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

- `deep_research` starts a stored background interaction and polls for a cited report. It returns the interaction ID alongside the report.
- `deep_research_followup` accepts that ID and a question. It retrieves the completed agent report and sends its text and the question to the model in separate content parts. For further questions, pass the ID from the latest follow-up to continue that model conversation.

On 2026-11-28, `deep-research-preview-04-2026` returned a cited report. Google returned 404 for
`deep-research-latest`. Follow-ups use `gemini-flash-latest`, which answered a question using the
retrieved report. Google rejects a model request that passes an agent ID as `previous_interaction_id`.

Each follow-up makes one read and at most one billable model request. A provider error or a
response requiring continuation ends the call. Google estimates $1–3 for a typical background
research task. [Deep Research pricing](https://aistudio.google.com/docs/deep-research#estimated-costs)

Stored IDs are scoped to the issuing Gemini project and Google's retention period. The connector
can also read stored research reports in the legacy output format. Both tools carry read-only
annotations. The connector exposes no resources or prompts.

## Limits and troubleshooting

Research typically takes 5–20 minutes and the connector enforces a finite 60-minute ceiling.
Progress is sent only when the MCP caller supplies a progress token. Cancellation aborts active
HTTP/polling and attempts a separately bounded provider cancellation after an interaction ID is
known; provider work may continue if that attempt fails. Do not start a duplicate topic immediately
after a timeout because the original may still be running and charging upstream. Clients need their
own finite timeout longer than expected research and must close/abort abandoned transports.
