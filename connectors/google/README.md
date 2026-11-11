# Google connector

Independent HTTP service endpoints using the user's access token supplied by a gateway.
Google Tasks uses `/tasks/mcp`, Contacts uses `/contacts/mcp`, and the separate Workspace
directory offer uses `/directory/mcp`. Gmail's send-only offer uses `/gmail/mcp`; the separate read-only offer uses `/gmail-read/mcp`.
`/mcp` and stdio are deliberately not exposed for this
multi-service package. Source is MIT; the shared kit retains its license.

## Authentication and setup

Enable the Google Tasks API and/or People API in the operator's Google Cloud project for the
services being offered. Register a Web OAuth
client, configure an External consent audience for personal accounts, and register the exact
gateway callback `https://<gateway-host>/api/oauth/callback`. Configure that client on a
per-user managed preset, request offline access for refresh, and let the gateway store and
renew credentials. The connector does not receive the client secret or refresh token.

The Tasks write scope is `https://www.googleapis.com/auth/tasks`; it covers reads as well.
It is a **sensitive** scope, as confirmed in Google Auth Platform's Data Access page on
2026-11-07; it is not a restricted scope. Complete the applicable sensitive-scope verification
before public rollout. Recheck the classification in the operator's project when configuring
it: Google's [scope documentation](https://developers.google.com/identity/protocols/oauth2/scopes)
identifies the console as the source of sensitive-scope indicators. Tasks alone does not add a
restricted-scope CASA requirement; other grants in the same app need their own assessment.
This package does not claim that registration or verification has been completed.
Google's official Workspace MCP services do not currently offer a Tasks endpoint; this package
implements the Tasks REST API directly, without an integration aggregator.

The runtime requires its service bearer in `Authorization`, explicit `per_user` mode and a
canonical base64url access token in `X-MCP-Upstream-Credential`. It never uses a shared token.
See [runtime authentication](../../docs/runtime.md).

## Tools

`tasks_list_tasklists`, `tasks_get_tasklist`, `tasks_create_tasklist`,
`tasks_rename_tasklist`, `tasks_delete_tasklist`, `tasks_list_tasks`, `tasks_get_task`,
`tasks_create_task`, `tasks_update_task`, `tasks_complete_task`, `tasks_move_task`,
`tasks_delete_task`, `tasks_clear_completed`.

List tools return one page, preserving Google's `nextPageToken`. Pass it back as `pageToken`.
Task lists and tasks use explicit IDs; `@default` can address the default task list.
Task due dates use RFC3339 input but Google stores the date, without time-of-day semantics.
Updates patch supplied fields only. `tasks_clear_completed` hides completed tasks as the
provider's clear endpoint specifies; it does not delete the list. Deletes and clear are marked
destructive. Integrator writes still need the gateway preset's write permission.

Each tool call has one 20-second deadline, including non-cancellable DNS preparation. Provider redirects are refused. Safe reads retry bounded 429/5xx responses; writes retry
only an explicit 429 refusal. A long throttle returns `RATE_LIMITED` and `retryAfterMs` instead
of waiting. A definite HTTP 401 throws the runtime's upstream credential signal. Insufficient
scope (403), network failures and uncertain write outcomes never trigger that signal.

Build with `pnpm build`; run `pnpm --filter @dxheroes/mcp-google test`.
The independent image tag is `google-v<package-version>`; publishing uses the repository's
normal signed, native multiarch release workflow. No image is published by local tests.

## Validation status

Automated tests use synthetic provider responses, actual HTTP listeners and official MCP SDK
clients in both protocol eras. Live personal/Workspace accounts, gateway managed-preset setup,
image publication and the end-to-end integrator acceptance remain required before rollout.
Generate an OAuth offer with `node scripts/catalog-manifest.mjs deployment.json`, where the
explicit deployment map contains `{"google-tasks":"https://<connector-host>/tasks/mcp"}`.
The package ID `google` is not a catalog offer alias. Only enable that source after the consuming
gateway supports connector OAuth and managed presets; do not substitute an API-key offer.

API reference: <https://developers.google.com/workspace/tasks/reference/rest>.

## Gmail: Wave 1, send only

The official Gmail MCP server admitted both personal and Workspace test accounts on
2026-11-08, but its 23 advertised tools included no sending operation. That live
inventory satisfies [issue #6](https://github.com/DXHeroes/mcp-servers/issues/6)'s
missing-sending prerequisite. This implementation adds that capability as a separate
`google-gmail-send` catalog offer at `/gmail/mcp`. It is shared connector infrastructure,
with no gateway edition restriction. Existing official read connections remain available.

Enable the Gmail API and use the common per-user Web OAuth setup above. The offer
requests **only** `https://www.googleapis.com/auth/gmail.send`, a **sensitive** scope.
Both tools use that grant:

| Tool | Behavior | Scope / class |
| --- | --- | --- |
| `gmail_send_message` | Send a new message, with To, Cc, Bcc, plain text, HTML and base64 attachments | `gmail.send` / sensitive |
| `gmail_reply_message` | Send into an existing thread using caller-supplied threading headers | `gmail.send` / sensitive |

Both tools change external state and are non-idempotent. The gateway's approval and
integrator write policy still apply. This scope does not itself introduce restricted-scope
CASA requirements. The app still needs applicable sensitive-scope verification for public
rollout; the operator's shared app must separately assess its other grants.
[Google's scope classification](https://developers.google.com/workspace/gmail/api/auth/scopes)
lists `gmail.readonly` and `gmail.compose` as restricted. Mailbox reads are available only through the separate read offer below; draft
management is not implemented. Public release of restricted-scope functionality remains dependent on the requesting app's restricted-scope review and,
where required, security assessment. Internal testing consent does not satisfy that gate.

Address fields use bare ASCII email addresses. Optional `senderDisplayName` is separately
encoded into From using RFC 2047; optional `replyTo` is one bare address. Optional `messageId`
is a stable RFC Message-ID including angle brackets, e.g. `<job.123@example.test>`.
Omitting these fields preserves the previous generated Message-ID and From behavior. A stable
Message-ID supports reconciliation, but Google does not promise send deduplication. Supply `from`
as the authenticated mailbox or an authorized send-as alias; Google enforces sender
permission. At least one of `to`, `cc`, `bcc` must contain a recipient (100 total maximum),
and at least one of `text` or `html` must be supplied. Both bodies produce MIME alternatives.
Up to ten attachments use `filename`, `contentType` and canonical padded `contentBase64`.
The combined UTF-8 body and decoded attachment content is limited to **1 MiB** for this
interactive endpoint. The shared runtime separately caps the entire incoming JSON request
at 2 MiB. Filenames are UTF-8 RFC 2231 parameters; subjects are RFC 2047 encoded words.
Header controls, malformed base64, extra fields and over-limit content are refused before
any send. Attachments are bytes supplied by the caller; the connector reads no local files
or remote attachment URLs.

For a reply supply `threadId` (Gmail's opaque thread ID), `inReplyTo` (the original
**RFC Message-ID header**, including angle brackets), and `references` (the existing chain
followed by that same original Message-ID). These are different identifiers. Set `subject`
to the original thread subject; this endpoint does not fetch, infer or change it. Google
requires matching subjects and compliant References/In-Reply-To headers to thread replies.
Only ordinary dot-atom Message-ID forms are accepted, not quoted local parts. Example:

```json
{"from":"sender@example.test","to":["recipient@example.test"],"subject":"Fixture thread","text":"Synthetic reply","threadId":"abc123","inReplyTo":"<original@example.test>","references":["<original@example.test>"]}
```

The only provider call is `POST /gmail/v1/users/me/messages/send` with base64url MIME
and, for replies, `threadId`. A definite HTTP 401 signals reconnect. HTTP 403 remains a
permission/provider error. Only definite short HTTP 429 refusals are retried; a long throttle
returns `RATE_LIMITED`. Network errors, deadlines, malformed success responses and 5xx can
mean that mail **was already sent**: they return `SEND_OUTCOME_UNKNOWN`. Do not automatically
retry that outcome; reconcile using the mailbox/product before deciding to send again.
The connector cannot perform that readback under `gmail.send`. No automatic resend follows
an uncertain outcome.

Catalog deployment map entry:

```json
{"google-gmail-send":"https://<connector-host>/gmail/mcp"}
```

Gmail tests use synthetic/adapted provider responses, not recordings of a live send.
They cover MIME, validation, threading, retry/error behavior and two isolated credentials
over actual MCP HTTP in both protocol eras. Live send/reply on both account kinds,
gateway approvals, refresh/revocation, preview acceptance, image publication and p95
acceptance remain open. No real email is sent by these tests.

Primary references: [send endpoint](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send),
[MIME message creation](https://developers.google.com/workspace/gmail/api/guides/sending),
[threading requirements](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages#Message).

## Google Contacts and Workspace directory

Contacts is implemented from scratch because the required product route includes
writes. The official People MCP route's read-only coverage does not meet that
requirement. This does not decide the pending official-route verification for
Gmail, Calendar or Drive, and is not a hybrid official/custom Contacts endpoint.

| Offer | Endpoint | Scope | Rollout class / capability |
| --- | --- | --- | --- |
| `google-contacts` | `/contacts/mcp` | `https://www.googleapis.com/auth/contacts` | Sensitive; personal and Workspace contact read/write |
| Read-only alternative, not a separate deployed offer | Same People read APIs | `https://www.googleapis.com/auth/contacts.readonly` | Sensitive; insufficient for this offer's writes |
| `google-directory` | `/directory/mcp` | `https://www.googleapis.com/auth/directory.readonly` | Sensitive (confirmed in Data Access on 2026-11-07); Workspace domain directory only |

The full `contacts` grant already covers reads, so the write offer does not request
the redundant `contacts.readonly` grant. It never adds directory permissions to a
personal Contacts connection. The directory route exposes only `directory_search`,
requests only `directory.readonly`, and does not expose contact mutation tools.
Directory access requires a Workspace account, domain administrator-enabled
external contact/profile sharing and any tenant app approval. Google enforces that
account/domain restriction; this connector does not infer account type from an
opaque access token or label a 403 as an empty directory. These routes do not
request Gmail or Drive restricted scopes. No restricted-scope CASA requirement is
introduced by Contacts itself; other grants on the operator's shared app still
need their own review. Verify current classifications in that app's Google Cloud
Data Access page and finish the applicable consent verification before rollout.

Use the common Web OAuth setup above, an External consent audience for personal
Contacts users, the exact gateway callback, offline consent and gateway-owned
refresh. Register a separate managed preset for each offer, keeping the directory
offer available only for the Workspace use case. No client secret or refresh token
reaches the connector. This package claims neither app registration nor consent
approval. See [scope definitions](https://developers.google.com/identity/protocols/oauth2/scopes#people),
[consent setup](https://developers.google.com/workspace/guides/configure-oauth-consent),
and [domain directory requirements](https://developers.google.com/people/v1/directory).

### Contact tools and data

| Tool | Behavior |
| --- | --- |
| `contacts_search` | Prefix search with cache warmup, up to 30 matches |
| `contacts_get` | Contact-only Person read, including source metadata |
| `contacts_list_groups` | One group page, preserving `nextPageToken` |
| `contacts_create` | Create native People contact data |
| `contacts_update` | Replace supplied field arrays with source-etag protection |
| `contacts_delete` | Permanently delete contact data; marked destructive |
| `contacts_add_to_group` | Add one contact to a user group or supported system group |

`contacts_search` first makes the provider's prescribed empty-query warmup request
under the same user's credential, then performs the real search. Both requests
share one 20-second budget; the warmup result is not returned. This search API has
no page token and returns at most 30 matches; do not infer that it enumerates all
contacts. Group lists default to 100, maximum 1,000. Directory search returns one
page (default 100, maximum 500), preserving `nextPageToken`; keep other query fields
unchanged between pages. All pagination values are opaque query parameters,
never provider URLs. Directory sources are explicit repeated query parameters.

Contact reads request `READ_SOURCE_TYPE_CONTACT`, without merging profile or
directory data. Optional `fields` chooses the returned native Person fields;
`metadata` is always added so callers can obtain the source version. The default
mask is `names,emailAddresses,phoneNumbers,memberships,metadata`. Read-only Person
fields can be requested in reads, but cannot be supplied as writable top-level data.

Create and update accept `person`, an object containing native People API field
arrays. Supported writable fields are `addresses`, `biographies`, `birthdays`,
`calendarUrls`, `clientData`, `emailAddresses`, `events`, `externalIds`, `genders`,
`imClients`, `interests`, `locales`, `locations`, `memberships`, `miscKeywords`,
`names`, `nicknames`, `occupations`, `organizations`, `phoneNumbers`, `relations`,
`sipAddresses`, `urls` and `userDefined`. Field entries are bounded JSON objects;
Google validates field-specific formats and semantics. No arbitrary top-level
Person property is forwarded. The connector caps complete input at 64 KiB and
ten nesting levels, field arrays at 100 entries, and provider-singleton fields
(`names`, `birthdays`, `genders`, `biographies`) at one entry.

Example creation arguments:

```json
{"person":{"names":[{"givenName":"Alex","familyName":"Fixture"}],"emailAddresses":[{"value":"alex@example.test","type":"work"}]}}
```

For updates, first read the same contact and select its `metadata.sources` entry
with `type: "CONTACT"`. Supply that entry's `id` and `etag` as `source`. The connector
puts them in the People update body, derives `updatePersonFields` only from the
supplied arrays, and preserves every omitted field. An empty array explicitly
clears a field; an empty `memberships` update is refused as Google requires a
contact group membership. Example:

```json
{"resourceName":"people/c123","source":{"id":"123","etag":"etag-from-read"},"person":{"names":[{"givenName":"Updated"}],"emailAddresses":[]}}
```

A stale source version remains a provider error: the connector does not fetch a
new etag and overwrite a concurrent change. After a successful update use the new
source etag in its response. Profile resources such as `people/me` cannot be
mutated. Delete has no documented source-etag argument; it deletes contact data,
without deleting associated non-contact profile data. Group member addition checks
`notFoundResourceNames` even at HTTP 200 and returns `CONTACT_NOT_FOUND` instead of
claiming success. Most system groups do not allow additions; `myContacts`, `starred`
and user groups are the supported provider targets.

Mutations sharing the same credential are queued sequentially across instances
inside one connector process. The wait shares the call's deadline/cancellation;
an abandoned queued call never dispatches later. This is not a cross-replica or
cross-token user lock. Google recommends sequential user mutations; source-etag
checks still enforce update conflicts at the provider. Coordinate product writes
accordingly. Reads and other credentials can proceed independently.

The shared Google transport pins the service origin, refuses redirects, caps
responses at 2 MiB and cancels its owned body reader on abort. All requests,
including warmup and mutation queueing, fit the same 20-second logical budget.
Reads retry bounded 429/transient 5xx; writes retry definite 429 only. Permission
errors and stale-version errors do not become reconnect. A definite HTTP 401 uses
the existing upstream credential signal. Error details are fixed and never echo
provider bodies. The managed-preset integrator write policy remains authoritative.

### Contacts validation status

Automated tests use synthetic/adapted People responses, including source-version
conflicts, partial group failures, two accounts and real MCP HTTP in both eras.
They do not replace recordings or real personal/Workspace read/create/update
acceptance. Provider app setup, consent, directory sharing, revoked-token/refresh,
preview acceptance, publication and p95 measurement remain open.

The explicit catalog deployment map can contain the separate offers:

```json
{"google-tasks":"https://<connector-host>/tasks/mcp","google-contacts":"https://<connector-host>/contacts/mcp","google-directory":"https://<connector-host>/directory/mcp"}
```

Primary references: [contact search](https://developers.google.com/people/api/rest/v1/people/searchContacts),
[create](https://developers.google.com/people/api/rest/v1/people/createContact),
[update](https://developers.google.com/people/api/rest/v1/people/updateContact),
[delete](https://developers.google.com/people/api/rest/v1/people/deleteContact),
[group members](https://developers.google.com/people/api/rest/v1/contactGroups.members/modify),
[directory search](https://developers.google.com/people/api/rest/v1/people/searchDirectoryPeople).


## Read-only Gmail contract (0.3.0)

`google-gmail-read` is a separate catalog offer at `/gmail-read/mcp`. Its only scope is
`https://www.googleapis.com/auth/gmail.readonly`; it exposes no send, update, label or draft
operation. This is a restricted scope. The operator owns app verification and any applicable
security assessment before public rollout. Google credentials stay in the gateway and every
request requires the existing service bearer plus explicit `per_user` credential delivery.

Every successful tool result returns `structuredContent.mailbox` as
`{emailAddress, verified: true, source: "users.getProfile"}`. The profile is fetched with the
same delegated token on every logical call, within the same 20-second deadline. It proves
mailbox identity, not authorized send-as aliases. The send-only grant cannot call getProfile
or enumerate settings.sendAs; alias authorization remains Google's send-side check.

| Tool | Arguments | Result fields besides mailbox |
| --- | --- | --- |
| `gmail_list_messages` | `q?` (max 1024 chars), `maxResults?` (1–100, default 50), `pageToken?`, `includeSpamTrash?` (default false) | `messages: [{id, threadId}]`, `resultSizeEstimate?`, `nextPageToken`, `complete` |
| `gmail_find_sent_message` | `messageId` (RFC Message-ID), `maxResults?` (1–100, default 10), `pageToken?` | Same reference page; query is always `in:sent rfc822msgid:<caller-id>` |
| `gmail_get_message` | `id` (Gmail opaque ID), `maxBodyChars?` (1–65536, default 32768), `cursor?` | `message`, `nextCursor`, `complete` |
| `gmail_get_thread` | `id` (Gmail opaque thread ID), `maxResults?` (1–20, default 10), `maxBodyChars?` (per message), `cursor?` | `id`, `historyId?`, `messages`, `totalMessages`, `nextCursor`, `complete` |
| `gmail_get_attachment` | `messageId`, exactly one of `attachmentId` or inline `partId`, `maxBytes?` (1–1048576, default 262144) | Requested IDs, `size`, canonical padded `contentBase64`, `complete: true` |

List/search reads return one provider page. `nextPageToken: null` means no remaining provider
page. A search can return zero, one or multiple candidates; callers must exhaust pagination
before inferring absence or uniqueness. No read automatically replays a send.

Ordinary message reads first request a finite MIME metadata projection using Google's
`fields` parameter, excluding **every body.data field**. Attachment boundaries include
filename and `Content-Disposition: attachment`, including unnamed text attachments and
whole nested attachment containers. Non-text parts are never downloaded by ordinary reads.
Headers and references remain available when an inline attachment is larger than 2 MiB.

For attachment-free, fully expanded MIME structures with at most 1 MiB of declared body
bytes, get_message then retrieves and decodes text/plain and text/html using the declared
charset (UTF-8 by default). No HTML is executed and no URLs are followed. Header values
remain original, including encoded words. Text output has `text`, `textOffset`, `totalChars`
and `complete`; cursors page Unicode code points across decoded parts.

When a message includes attachments, body bytes remain explicit references, including text
siblings: Google's fields selectors apply to arrays as a whole and cannot select one MIME
array element by index. Each deferred text part has `complete:false`, an actionable
`bodyReference` to `gmail_get_attachment`, and an official `providerReference` with method,
Google API path, query and `supportsRange:false`. Attachments expose metadata (partId,
mimeType, filename, size, optional attachmentId) and explicit attachment/provider references.
The existing attachment operation preflights inline metadata and declared size before any
body download. Its decoded size maximum remains 1 MiB and transport response maximum 2 MiB.
A trusted host requiring larger parts must use the providerReference under its own approved
size policy; Gmail's documented message/attachment APIs provide no body range or offset API.
These provider references contain no credential or invented range/cursor parameter.

**Thread behavior:** get_thread always requests `format:minimal` and a small ID/history
projection. Its messages are references with `complete:false` and
`bodyReference:{tool:"gmail_get_message",arguments:{id,maxBodyChars}}`. Follow each reference
to read that message's headers and parts. Thread cursors page only this ID list; they never
repeat an oversized full-thread request. Gmail threads.get has **no provider pageToken**.
For a nonempty thread, complete remains false even on the last ID page, because message
reads are still pending. nextCursor=null means the ID traversal ended, not that content
was read. Consumers must track completion of referenced messages separately.

**Message completion:** message.complete/top-level complete covers decoded text, headers
and attachment references. Attachment-only messages can therefore be complete while their
attachment bytes are still explicitly unread. A deferred text part keeps the message
incomplete, including oversized inline bodies and text stored behind an attachmentId.
message.bodyReference points to the first deferred text read, or to an actual continuation
cursor when decoded text has another page; it never points back to the same ordinary read
without progression. Inspect every part's reference to cover all deferred content.
For reconciliation, the host must explicitly fetch and validate all parts/attachments
required by its decision; it must not infer content completeness from nextCursor alone.

Oversized inline text is returned as metadata plus explicit body/provider references and
complete=false, with no fake retry cursor. If even the bounded MIME/header projection exceeds
the transport's unchanged 2 MiB cap, get_message falls back to a minimal ID projection with
complete=false, `reason:"METADATA_EXCEEDS_RESPONSE_LIMIT"`, and a provider metadata reference.
Unexpected oversize bounded body downloads retain the previously fetched metadata and
references. A failed explicit part read returns RESPONSE_TOO_LARGE or ATTACHMENT_TOO_LARGE;
it never turns into a successful empty body. Extremely large minimal ID projections still
fail at the transport limit. No automatic send retry follows any read result.

List/find validation rejects unrecognizable objects and empty transport responses, including
empty 200/204/205 bodies. Recognizable empty provider lists `{resultSizeEstimate:0}` and
`{messages:[]}` remain supported. In particular, an invalid response cannot establish absence
of a sent message. Invalid provider shapes/encoding/size return INVALID_PROVIDER_RESPONSE;
unsupported declared charsets return UNSUPPORTED_CHARSET. Other fixed codes include
INVALID_ARGUMENTS, UNKNOWN_TOOL, STALE_CURSOR, ATTACHMENT_NOT_FOUND, ATTACHMENT_TOO_LARGE,
RESPONSE_TOO_LARGE, READ_FAILED, PROVIDER_ERROR and RATE_LIMITED (with status/retryAfterMs
when applicable). A definite 401 uses the existing upstream reconnect signal. Error results
never expose token values or provider bodies.

First-party host imports are available from `@dxheroes/mcp-google/gmail-message`:
`buildGmailMessage(input: unknown, reply?: boolean): {raw: string; threadId?: string}`,
`gmailSendSchema`, `gmailReplySchema`, `rfcMessageIdSchema` and type `GmailMessageArgs`.
The helper validates the same strict bounded inputs as the send tools and performs no I/O.
`GoogleGmailReadServer` is also exported from the package root and `./gmail-read`.
The source package stays `private: true`; these workspace exports do not imply npm publication.

Deployment map example:

```json
{"google-gmail-read":"https://<connector-host>/gmail-read/mcp","google-gmail-send":"https://<connector-host>/gmail/mcp"}
```

Release preparation targets `google-v0.3.0` → `ghcr.io/dxheroes/mcp-google:v0.3.0` through the
existing signed native amd64/arm64 image workflow. The controller owns the tag, publication,
immutable image digest, signature verification and deployed endpoint proof. Local build/tests
publish nothing. Read/send live acceptance, actual alias behavior and the deployed artifact
remain unverified; use an immutable verified image before connecting an action adapter.

Primary references: [profile identity](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile),
[message listing/search](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list),
[message structure/thread criteria](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages),
[partial response fields](https://developers.google.com/workspace/gmail/api/guides/performance#partial-response),
[message get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get),
[thread get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get),
[attachment get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments/get).

## Sender-bound action adapter

The host-only `./action-adapter` export integrates with an existing durable action broker.
See [installation, authorization and recovery contract](./ACTION-ADAPTER.md).
