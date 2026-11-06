# Microsoft Teams connector

From-scratch Graph v1.0 tools for work and school accounts: chats, team/channel discovery, channel
threads and tenant-user lookup for mentions. One HTTP OAuth offer, `microsoft-teams`, at `/mcp`.
Source is MIT. The gateway owns OAuth and refresh; no aggregator, application-only token, client
secret or shared user credential is used by this connector. There is no stdio mode.

The official Work IQ route requires its own organization/admin/billing setup and cannot serve the
individual delegated-user use case of [issue #10](https://github.com/DXHeroes/mcp-servers/issues/10).
Using Graph directly still requires the permissions and tenant consent below.

## Register the application

1. Register a Microsoft Entra application for **accounts in any organizational directory**, excluding
   personal Microsoft accounts. Use the `organizations` authority, not `common` or `consumers`.
   Both authorization and token endpoints are
   `https://login.microsoftonline.com/organizations/oauth2/v2.0/{authorize|token}`.
2. Add a **Web** redirect URI of `https://<gateway-host>/api/oauth/callback`, matching the gateway's
   exact public URL. Put the application client ID/secret only in its gateway OAuth configuration.
   The preset uses pre-registered credentials, with no DCR; the gateway handles PKCE and refresh.
3. Add the following **delegated**, not application, Microsoft Graph permissions:

| Scope | Purpose | Graph admin consent required |
| --- | --- | --- |
| `User.Read` | Current user profile | No |
| `offline_access` | Gateway refresh | No |
| `Chat.ReadWrite` | Read/post own chats | No |
| `ChannelMessage.Read.All` | Read accessible channel threads/replies | **Yes** |
| `ChannelMessage.Send` | Post/reply in accessible channels | No |
| `Team.ReadBasic.All` | Discover directly joined teams | No |
| `Channel.ReadBasic.All` | Discover visible channels | No |
| `User.ReadBasic.All` | Basic tenant profiles for mentions | No |

`User.ReadBasic.All` is necessary for the required directory search; `User.Read` alone cannot list
other users. It exposes only basic profiles. Channel-message reads require administrator consent;
tenant policies can also require approval for the other scopes. Publisher verification may be
needed by risk-based consent policies. No setup, consent or verification has been performed here.

4. Create a per-user managed preset from the catalog offer. Its `organizations` endpoint restricts
   sign-in to work/school accounts before tools are reached. Microsoft controls the sign-in prompt;
   real preview acceptance must verify that a personal-account attempt gets a clear work/school
   account error. Do not change this preset to a personal-account authority.
5. Use a dedicated work test account/chat/channel for acceptance. Post only synthetic messages and
   remove those messages using Teams afterward; this connector does not provide delete tools.
   Tenants/membership/license policies remain enforced by Graph.

References: [authority audiences](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc),
[register an app](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app),
[permission/admin-consent reference](https://learn.microsoft.com/en-us/graph/permissions-reference),
[basic directory lookup](https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0).

## Deployment and authentication

Build with `pnpm build`; run `node connectors/microsoft-teams/dist/cli.js --http`. The independent
image tag is `microsoft-teams-v<package-version>`; first signed multiarch release is pending. The
runtime requires its service bearer and explicit `per_user` mode with the canonical base64url
access token in `X-MCP-Upstream-Credential`; shared mode is refused. See [runtime](../../docs/runtime.md).
No service bearer is forwarded to Graph. The catalog deployment map is:

```json
{"microsoft-teams": "https://<connector-host>/mcp"}
```

Generate with `node scripts/catalog-manifest.mjs <deployment-map.json>` after building. The consuming
gateway needs connector-OAuth/managed-preset support; integrator writes require its preset's write
permission. A catalog record is not proof of a deployed connector or completed provider setup.

## Tools

| Tool | Behavior |
| --- | --- |
| `teams_list_chats` | One page of own chats; optional chat type and page size |
| `teams_list_chat_messages` | One page of messages with supported descending date filters |
| `teams_send_chat_message` | Post in an existing chat |
| `teams_list_joined_teams` | Teams of direct membership |
| `teams_list_channels` | Visible channels; optional membership type |
| `teams_list_channel_messages` | Root messages of a channel; excludes replies |
| `teams_list_replies` | Replies to a specific root message |
| `teams_post_channel_message` | Root channel post, optional subject |
| `teams_reply_in_thread` | Reply to a root channel message |
| `teams_search_users` | Basic tenant profiles by display-name/mail/UPN prefix |

Lists return one page and preserve `@odata.nextLink`; pass it back as `nextLink` with the same
resource IDs. Cursors cannot select another collection or forward credentials to another origin.
Equivalent encoded resource IDs and self/chat owner aliases are handled by the shared Graph
transport. A supplied cursor carries the provider's continuation query.

Chat/message/reply page sizes are at most 50. Chat-message ordering is descending by
`lastModifiedDateTime` or `createdDateTime`; after/before filters target that property, and
`createdDateTime` supports before only. A filter always sends the matching order, so Graph cannot
silently ignore it. Joined-team discovery accepts no unsupported OData options and does not include
host teams known only through a shared channel. Channel listing omits the expensive email field;
Graph hides private/shared channels without membership. Directory lookup cannot be used by guests
and uses only basic profile fields; arbitrary OData/Graph expressions are not accepted as input.

Post body is `{contentType: "text"|"html", content: "..."}`. Mentions require HTML with a matching
`<at id="0">Alex</at>` tag and a `mentions` entry:

```json
{
  "chatId": "19:example@thread.v2",
  "body": {"contentType": "html", "content": "Hello <at id=\"0\">Alex</at>"},
  "mentions": [{"id": 0, "mentionText": "Alex", "mentioned": {
    "user": {"id": "00000000-0000-4000-8000-000000000001", "displayName": "Alex", "userIdentityType": "aadUser"}
  }}]
}
```

Use IDs returned by directory lookup. The connector rejects duplicate/missing mention references
and text-mode mentions before HTTP. Posted content is bounded to 28 KiB serialized tool input,
with at most 50 mention records; provider limits can be stricter. Posts are not automatically
replayed after uncertain network/5xx outcomes. These tools do not create chats or channels.

API references: [list chats](https://learn.microsoft.com/en-us/graph/api/chat-list?view=graph-rest-1.0),
[chat messages](https://learn.microsoft.com/en-us/graph/api/chat-list-messages),
[send chat message](https://learn.microsoft.com/en-us/graph/api/chat-post-messages?view=graph-rest-1.0),
[joined teams](https://learn.microsoft.com/en-us/graph/api/user-list-joinedteams?view=graph-rest-1.0),
[channels](https://learn.microsoft.com/en-us/graph/api/channel-list?view=graph-rest-1.0),
[channel messages](https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0),
[replies](https://learn.microsoft.com/en-us/graph/api/chatmessage-list-replies?view=graph-rest-1.0).

## Errors, limits and tests

One 20-second tool deadline covers all preparation/HTTP, caller cancellation and body reads. It
bounds uninterruptible DNS waits and prevents late dispatch. Responses are capped at 2 MiB.
Reads retry bounded 429/5xx; writes retry only definite 429 with Retry-After. Three attempts,
two seconds per wait and four seconds total waiting are allowed; longer throttles return
`RATE_LIMITED` and retry timing. HTTP 401 emits the runtime's credential-invalid signal for gateway
reconnect. Permission/tenant denials remain fixed `PROVIDER_ERROR`, never reconnect or empty tools.
Provider error bodies/tokens/causes are not returned. Reads are annotated read-only; posts are
non-idempotent. There are no destructive tools in this package.

Run `pnpm --filter @dxheroes/mcp-microsoft-teams test` and `pnpm check`. Tests exercise real local MCP
HTTP in both eras, two synthetic work tokens, reads/posts and transport boundaries. They use
synthetic provider responses, not recorded work-account behavior. Provider login/personal-account
rejection, admin consent, recorded responses, shared-gateway preview, actual read/write and p95
latency remain acceptance gates. Kit/runtime licenses and unrelated long-running tools are unchanged.
