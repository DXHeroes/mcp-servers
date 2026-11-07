# Shared Microsoft Graph transport

Internal MIT workspace package used by the Outlook and Microsoft Teams connectors. It is not a
catalog offer, npm release or standalone image. Connectors declare their own immutable operation
paths, delegated scopes, account audience and caller-facing validation/errors.

`GraphClient` pins HTTPS Microsoft Graph v1.0. Its constructor copies an author-supplied subset of
`me`, `chats`, `teams` and `users` roots, with `me` as the default. Optional fixed headers are copied;
the current access token always replaces Authorization, regardless of header casing. It never
accepts an API origin, token, method or path from a connector caller's arbitrary JSON object.

Every request uses the kit's 20-second deadline. A surrounding tool budget is inherited, so a
multi-request tool cannot extend it. Provider redirects are refused; requests and body reads
observe cancellation, and delayed DNS cannot dispatch after expiry. At most 2 MiB of JSON is
accepted. Explicit 401 becomes the runtime credential-invalid signal. Other error bodies are
cancelled and discarded; only status/retry timing is retained. Reads may retry 429/5xx; writes retry
only 429, with bounded Retry-After pacing. The gateway owns OAuth exchange and refresh.

A continuation must refer to the same HTTPS origin and collection. Encoded resource segments are
compared after decoding each segment separately. Self-owned `me`/`users/{id}` and chat aliases are
normalized only for self/chat collection requests; requests still dispatch through the original
connector-authored path. Directory and team collections keep exact resource identity. Query
continuation is preserved. Invalid host, path, credentials or fragment is refused.

Outlook keeps its `me` scope and UTC response preference through a small local adapter. Teams grants
only its fixed chat, team, self and basic-directory operation roots. Both consume the same token
and redirect protections. Kit and runtime licenses/provenance remain unchanged.
