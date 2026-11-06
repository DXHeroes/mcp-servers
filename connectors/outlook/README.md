# Outlook connector

From-scratch Microsoft Graph v1.0 connector, with independent OAuth service offers:

| Offer | HTTP endpoint | Delegated scopes |
| --- | --- | --- |
| `outlook-mail` | `/mail/mcp` | `User.Read`, `offline_access`, `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.Read` |
| `outlook-calendar` | `/calendar/mcp` | `User.Read`, `offline_access`, `Calendars.ReadWrite` |

Both endpoints use the user's gateway-managed token. Personal Microsoft accounts and work/school
accounts use the `common` authority. There is no aggregator, shared mailbox credential, direct
OAuth exchange or refresh in this package. The source is MIT; shared kit licensing is unchanged.
This package's HTTP service endpoints have no `/mcp` alias or stdio mode.

Microsoft's Work IQ alternative cannot cover the required personal-account audience and requires
organization/admin/billing setup, so this connector implements Graph directly. See the approved
route in [issue #9](https://github.com/DXHeroes/mcp-servers/issues/9).

## Register and connect

1. In Microsoft Entra **App registrations**, register an app with **Any Entra ID Tenant + Personal
   Microsoft accounts**. A tenant-only or organizations-only app does not cover personal accounts.
2. Add a **Web** redirect URI of `https://<gateway-host>/api/oauth/callback`, exactly matching the
   gateway's public origin and callback. Create a client secret for the gateway and keep its value
   only in the gateway's encrypted OAuth configuration. Never put it in the connector or catalog.
3. Configure delegated Microsoft Graph permissions from the relevant row above, not application
   permissions. `Mail.ReadWrite` permits draft/folder/message updates; `Mail.Send` permits sending.
   `MailboxSettings.Read` is reserved for mailbox settings/time-zone compatibility. `User.Read`
   provides the self identity for the free/busy fallback. `offline_access` lets the gateway refresh
   the connection. Tenant consent policies can still require an administrator.
4. Configure each service as its own per-user managed preset with that client ID/secret. The static
   defaults use `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` and
   `https://login.microsoftonline.com/common/oauth2/v2.0/token`, with no DCR. `prompt=select_account`
   allows separate work and personal connections. The gateway handles PKCE, callback and refresh.
5. Complete publisher verification before rollout to tenants whose risk-based consent policy
   rejects new unverified multitenant apps. Verification is not a substitute for tenant consent.

Provider setup: [register an app](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app),
[publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview).
No app registration, publisher verification or real-account acceptance is claimed by this source.

Runtime authentication requires the service bearer in `Authorization`, explicit `per_user` mode
and the canonical base64url user token in `X-MCP-Upstream-Credential`. Service and user credentials
stay separate. See [runtime configuration](../../docs/runtime.md). A catalog deployment map uses
`outlook-mail` and `outlook-calendar`, not the package ID `outlook`:

```json
{
  "outlook-mail": "https://<connector-host>/mail/mcp",
  "outlook-calendar": "https://<connector-host>/calendar/mcp"
}
```

Generate with `node scripts/catalog-manifest.mjs <deployment-map.json>` after building. Import
only into a gateway with connector OAuth/managed-preset support; writes also require the gateway
preset's integrator-write permission. The independent image tag is `outlook-v<package-version>`;
its first signed multiarch release and deployment are pending.

## Mail tools

`mail_search_messages`, `mail_get_message`, `mail_get_conversation`, `mail_list_folders`,
`mail_create_draft`, `mail_update_draft`, `mail_send_draft`, `mail_send_message`, `mail_reply`,
`mail_reply_all`, `mail_forward`, `mail_move_message`, `mail_flag_message`, `mail_mark_read`.

Lists return one page and preserve `@odata.nextLink`; pass it back as `nextLink`, retaining the
same folder/conversation selection. Pagination never dispatches credentials to another host;
Graph's `/users/{id}` alias is rebound to `/me` so caller-supplied cursors cannot select another
mailbox. Resource IDs are opaque and URL encoded. Conversations use an escaped OData filter.
KQL `search` and OData `filter` are alternatives; search also excludes explicit `orderBy` and
Graph limits search results to 1,000. OData filters/order combinations must follow Graph's
supported property order. `select` is a comma-separated property list.

Create/update draft fields are Graph-shaped JSON: subject, body (`Text` or `HTML`), recipient
objects (`emailAddress.address` and optional name), importance and categories. Omitted patch
fields remain unchanged; Graph enforces draft-only edits after sending. Reply accepts either
plain comment or `message.body`, never both. Forward takes recipients and an optional comment.
Flagging accepts status and optional follow-up dates; marking read accepts `isRead: false` too.
Moving returns Graph's destination identifier. A successful send is **accepted**, not a delivery
receipt. Do not automatically replay a send after an uncertain network outcome.

References: [messages](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0),
[search](https://learn.microsoft.com/en-us/graph/search-query-parameter),
[draft updates](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0),
[send](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0),
[reply all](https://learn.microsoft.com/en-us/graph/api/message-replyall?view=graph-rest-1.0).

## Calendar tools

`calendar_list_calendars`, `calendar_list_events`, `calendar_get_event`, `calendar_create_event`,
`calendar_update_event`, `calendar_delete_event`, `calendar_respond_to_invitation`,
`calendar_get_free_busy`.

Calendar/event lists are paginated. Calendar view expands recurring occurrences and exceptions
in an explicit increasing RFC3339 range. Omit `calendarId` for the default calendar. Events accept
Graph-shaped start/end date/time/time-zone objects, subject/body, attendees, location display name,
reminders, all-day/busy/sensitivity/category settings, recurrence, transaction ID and online-meeting
settings. Windows/IANA support and recurrence constraints remain subject to Graph validation.
Updates preserve omitted fields; attendee updates may send meeting notifications. Deleting an
organizer's meeting can send cancellations and is marked destructive. Invitation response selects
`accept`, `tentativelyAccept` or `decline`, with optional comment/sendResponse.

Free/busy first uses `getSchedule`, up to 20 schedules in a range shorter than 62 days. Personal
accounts do not support that action. If it returns 400/403/404/501 and every requested address is
the current account's primary mail/userPrincipalName, the connector reads **all** default calendar
view pages instead. Omitting schedules resolves the current account first. The fallback identifies
`source: calendarView` and `scope: self`, returns busy/tentative/etc. intervals, omits cancelled and
free events, and states its limitations. It never infers availability for other people/resources,
shared/additional calendars or mail aliases not verified by the self profile. Missing, cyclic,
malformed or excessive paging fails instead of reporting partial availability. Explicit 401,
throttling and transient server failures do not trigger capability fallback.

References: [calendar view](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0),
[getSchedule account support and bounds](https://learn.microsoft.com/en-us/graph/api/calendar-getschedule?view=graph-rest-1.0),
[invitation response](https://learn.microsoft.com/en-us/graph/api/event-accept?view=graph-rest-1.0).

## Bounds and errors

A tool call has one 20-second cancellation budget, including multi-request free/busy. Reads retry
bounded 429/5xx refusals; writes retry only definite 429, using Retry-After. At most three attempts,
two seconds per wait and four seconds total waiting are allowed. Longer throttles return
`RATE_LIMITED` with `retryAfterMs` for the caller to schedule later. Network/5xx write outcomes are
not replayed. See [Microsoft throttling guidance](https://learn.microsoft.com/en-us/graph/throttling).

Responses are bounded to 2 MiB each. The free/busy fallback also caps total retained intervals at
2 MiB / 10,000 items / 64 pages. Message content is at most 512 KiB; recipient arrays at most 500.
A revoked/expired token (HTTP 401) throws the runtime's machine-readable upstream-credential signal
for reconnect. Other provider statuses yield fixed `PROVIDER_ERROR`/`RATE_LIMITED`; validation and
transport failures yield fixed errors without provider response bodies, access tokens or causes.
Read tools have `readOnlyHint`; event delete has `destructiveHint`.

Run `pnpm --filter @dxheroes/mcp-outlook test` and `pnpm check`. Tests use synthetic responses shaped
from the linked Graph references and real local MCP HTTP clients in both protocol eras. They do
not constitute recorded personal/work-account, provider-consent, latency or preview acceptance.
