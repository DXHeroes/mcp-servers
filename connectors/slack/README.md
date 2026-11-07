# Slack internal bridge

From-scratch Slack Web API connector using a separate user OAuth credential for each
connection. This package is an **internal pilot**, not the final public Slack route.
The migration target is Slack's official server at `https://mcp.slack.com/mcp`, after
provider app eligibility and complete gateway acceptance. Keep existing connections
until their final replacement passes confirmation. No community server or aggregator
is involved. Source is MIT; the shared kit retains its existing license.

## Distribution decision and rate limits

Prerequisite research was performed on 2026-11-06 before connector production code:

- Slack's [updated rate-limit announcement](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)
  restricts new commercially distributed non-Marketplace installations of
  `conversations.history` and `conversations.replies` to **one request/minute and
  15 messages/request**. Existing installations are treated separately; do not
  infer eligibility from an old install or a successful API call.
- Internal customer-built applications retain their existing limits, confirmed in
  the [June clarification](https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity/).
  The method pages describe normal Tier 3 operation. This connector caps history,
  conversation and user pages at 200 items, default 100, for the internal pilot.
- GO: the approved internal pilot. STOP: public commercial distribution as a
  replacement for the official service. An operator must establish app eligibility
  before offering this connector; it cannot infer distribution status from a token.
- Slack's [official MCP documentation](https://docs.slack.dev/ai/slack-mcp-server/)
  restricts that server to directory-published or internal apps. Official server
  approval, Marketplace listing and an external-workspace acceptance run are not
  proved by this package or its tests. Publication of source is not app approval.

Limits are per app, workspace and method, not simply per user token. The connector
honors provider throttling and does not claim a distributed quota coordinator.
It never bulk-traverses history, rotates identities to bypass limits or silently
returns empty history when throttled. Regular posting is also subject to Slack's
per-channel and workspace limits; see [rate limits](https://docs.slack.dev/apis/web-api/rate-limits/).

## OAuth app setup

Create the operator's Slack application and configure the **User Token Scopes**
below. Register the exact web redirect URI
`https://<gateway-host>/api/oauth/callback`. Configure its client ID and client
secret on the gateway's personal OAuth managed preset. The app must be approved
under the workspace's policies. Do not enable commercial distribution for this
pilot on the assumption that an internal test grants external eligibility.

This offer uses the documented [user-centric OAuth flow](https://docs.slack.dev/authentication/installing-with-oauth/):
`https://slack.com/oauth/v2_user/authorize` and
`https://slack.com/api/oauth.v2.user.access`, with standard `scope` and no bot
scopes. This is separate from `v2/authorize`, where user scopes use `user_scope`.
The gateway must support Slack's user-token response normalization. Enable and
validate token rotation through the operator's app settings when supported by
the registered client; rotating access and refresh tokens stay in the gateway.
Do not change the app's irreversible PKCE setting merely to test this connector.

| User scope | Required capability |
| --- | --- |
| `channels:read` | Public channel listing |
| `channels:history` | Public channel history and threads |
| `groups:read` | Visible private channel listing |
| `groups:history` | Private channel history and threads |
| `im:read` | One-to-one DM listing |
| `im:history` | One-to-one DM history and threads |
| `users:read` | User listing and profiles |
| `chat:write` | Message posting and thread replies |
| `reactions:write` | Reactions |
| `search:read` | Message search with the user's access |

No `mpim:*`, email, file, administration, channel-creation, message-editing or
message-deletion permission is requested. Group DMs are outside this pilot's
tool surface. Search can return any message accessible to the user under its
provider scopes and search settings, not just conversations listed by this tool.

The single `/mcp` HTTP endpoint requires service `Authorization`, explicit
`X-MCP-Credential-Mode: per_user` and canonical base64url user access token in
`X-MCP-Upstream-Credential`. Bot, app and refresh tokens are not accepted as user
credentials; supported user token formats are `xoxp-...` and `xoxe.xoxp-...`.
The connector receives neither refresh tokens nor client secrets. It exposes no
shared API-key offer. See [runtime authentication](../../docs/runtime.md).

## Tools and boundaries

| Tool | Behavior |
| --- | --- |
| `slack_list_conversations` | One page of public/private channels and one-to-one DMs |
| `slack_get_history` | One conversation history page, with optional time range |
| `slack_get_thread` | One thread page including its parent |
| `slack_search_messages` | Slack query syntax; numbered page or opaque cursor |
| `slack_list_users` | One user page |
| `slack_get_user` | User profile by ID |
| `slack_post_message` | Post text to an existing conversation |
| `slack_reply_in_thread` | Reply using the parent `thread_ts`; optional broadcast |
| `slack_add_reaction` | React using channel, message timestamp and emoji name |

Lists return the provider envelope, including `response_metadata.next_cursor`,
`has_more` and search paging data. Pass cursors back verbatim. A short or empty
page can still have a next cursor. History/thread bounds and message timestamps
remain strings; they are never rounded through JavaScript floating point.
Search supports at most 100 results and page 100. Use either `page` or `cursor`;
`cursor: "*"` starts cursormark search. It does not automatically read all pages.

Posting allows 1–4,000 text characters, a connector input bound. Explicit Slack
mentions can notify people. Link and media unfurls default off; `reply_broadcast`
can notify the whole conversation. No identity override, arbitrary blocks,
attachments or provider URL is accepted. Emoji names omit outer colons, e.g.
`thumbsup` or `thumbsup::skin-tone-6`. Six tools are read-only; three are writes.
The gateway's managed-preset write policy still controls integrator access.

Each complete tool call has one 20-second deadline, including DNS, HTTP, body
reading and bounded retries. Slack origin/methods are fixed; redirects are refused.
Responses are capped at 2 MiB. Safe reads can retry 429 and transient HTTP 5xx;
writes retry only a definite 429 refusal, including Slack's JSON `ratelimited`
response. There are at most three attempts, at most two seconds for a single
wait and four seconds across waits. Longer throttles return `RATE_LIMITED` with
`retryAfterMs`; uncertain network/5xx/logical write errors are never replayed.

Definite JSON `token_revoked`/`token_expired` errors propagate the established
upstream credential signal, including at HTTP 200. `invalid_auth` is ambiguous
between token validity and IP restrictions in Slack's reference, so it remains a
provider error. Permissions, app/workspace restrictions, raw HTTP failures and
unknown provider reasons never silently trigger reconnect. Error bodies are
replaced by a fixed error with optional status, allowlisted reason and retry delay.

## Build and validation

Run `pnpm build` and `pnpm --filter @dxheroes/mcp-slack test`.
Build locally with `docker build -f Dockerfile.connector --build-arg CONNECTOR=slack
-t mcp-slack:local .`. The independent release selector is `slack-v<package-version>`;
no release or public app distribution is authorized by these commands.
Generate the OAuth offer with `node scripts/catalog-manifest.mjs deployment.json`
and an explicit `{"slack":"https://<connector-host>/mcp"}` deployment map. Enable
it only on an eligible internal pilot deployment with compatible gateway OAuth.

Tests use synthetic/adapted provider responses and actual MCP HTTP clients in both
eras, with separate user tokens. They are not recordings of real accounts. Actual
Slack installation/consent, gateway refresh/revoke, user-visible identity, provider
rate-limit acceptance, preview read/write/read-back and measured p95 remain open.
The issue's sourced go/stop comment and any external-workspace acceptance remain
separate delivery obligations; local tests do not satisfy them.

API references: [history](https://docs.slack.dev/reference/methods/conversations.history/),
[threads](https://docs.slack.dev/reference/methods/conversations.replies/),
[search](https://docs.slack.dev/reference/methods/search.messages/),
[post](https://docs.slack.dev/reference/methods/chat.postMessage/),
[reaction](https://docs.slack.dev/reference/methods/reactions.add/).
