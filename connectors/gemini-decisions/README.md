# Gemini Decisions

Call `gemini_decisions` to ask 1–1,000 independent questions about the same input in a single billable request. The connector returns Google's named answers and token usage as MCP structured content and as JSON text.

Configure a Gemini Developer API key as the upstream credential and a separate service access token for the MCP endpoint. Standalone deployments accept `MCP_UPSTREAM_CREDENTIAL_FILE` and `MCP_ACCESS_TOKEN_FILE`. The key is sent to Google in the `x-goog-api-key` header.

## A mixed batch

Pass these arguments to `gemini_decisions`:

```json
{
  "input": "I bought a blue mug. It arrived with a chip in the rim.",
  "questions": {
    "damaged": {
      "type": "noul",
      "instructions": "Does the customer report damage?"
    },
    "send_to": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": { "returns": "Damaged goods", "billing": "Invoice issues" }
    },
    "severity": {
      "type": "score",
      "instructions": "How severe is the damage?",
      "criteria": ["No damage", "Cosmetic defect", "Unsafe to use"]
    }
  }
}
```

A `noul` answer gives the probability of yes. Optional `criteria.true_description` and `criteria.false_description` explain what counts as yes or no. A choice answer gives the winning option and the probability of each option. A score is a weighted average of zero-based rubric indices and may be fractional. Its legend maps each index to its description. Answers retain the provider's confidence when present. The separate `usage` field contains token counts.

Question names accept 1–64 ASCII letters, digits, underscores or hyphens. Supply 2–255 choice options or score levels. Choice descriptions may be empty. Option names accept up to 128 Unicode characters (512 UTF-8 bytes), with internal ASCII spaces allowed. Score level descriptions must contain text. Instructions accept a string, a text block or an array of text blocks. Google joins adjacent text blocks without inserting spaces.

## Shared input and media

Supply a string, one content block, or a nonempty array. Serialize structured JSON as text, for example `{"type":"text","text":"{\"item\":\"mug\",\"price\":12}"}`. These are example representations for media blocks (replace the illustrative URLs with accessible files):

```json
[
  { "type": "image", "uri": "https://example.org/mug.jpg", "mime_type": "image/jpeg", "resolution": "high" },
  { "type": "audio", "uri": "https://example.org/call.wav", "mime_type": "audio/wav" },
  { "type": "video", "uri": "https://example.org/delivery.mp4", "mime_type": "video/mp4", "resolution": "low" },
  { "type": "document", "uri": "https://generativelanguage.googleapis.com/v1beta/files/example", "mime_type": "application/pdf" }
]
```

For inline bytes, replace `uri` with `data` containing base64 and keep the MIME type. The connector forwards the blocks to Google. For local files, encode them on the client or upload them using Google's Files API. Public and signed HTTPS URLs are supported. YouTube and direct `gs://` URLs are unsupported. Images support low, medium, high and ultra-high resolution (`ultra_high`). Video supports low, medium and high.

The external connector accepts **2 MiB for the entire MCP HTTP request**, including the JSON-RPC envelope, questions and base64 expansion. This is smaller than Google's inline limits of 100 MB per request and 50 MB for PDFs. Use a Files API URI for large media. Google limits other external URLs to 15 MB each and the combined model context to 262,144 tokens.

## Model and failures

The connector calls `POST /v1beta/decisions` once per tool call. On 2026-11-28, the Developer API accepted the documented model `gemini-decision-1` and returned HTTP 404 for `gemini-decision-latest`. A call times out after 120 seconds or when its caller cancels. A structured Google `API_KEY_INVALID` error identifies an invalid key even when Google uses HTTP 400. Errors identify HTTP status (including authentication and quota errors) and omit upstream response bodies. Check the project, key, permissions or quota before starting another billable call.

[Google Decisions API reference](https://aistudio.google.com/docs/decisions-api)
