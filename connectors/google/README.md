# Google connector

Independent HTTP service endpoints using the user's access token supplied by a gateway.
Google Tasks is the first service, available at `/tasks/mcp`. `/mcp` and stdio are deliberately
not exposed for this multi-service package. Source is MIT; the shared kit retains its license.

## Authentication and setup

Enable the Google Tasks API in the operator's Google Cloud project. Register a Web OAuth
client, configure an External consent audience for personal accounts, and register the exact
gateway callback `https://<gateway-host>/api/oauth/callback`. Configure that client on a
per-user managed preset, request offline access for refresh, and let the gateway store and
renew credentials. The connector does not receive the client secret or refresh token.

The write scope is `https://www.googleapis.com/auth/tasks`; it covers reads as well.
It is not a restricted scope. Confirm its current sensitive/non-sensitive classification in
the project's consent configuration and complete any required app verification before public
rollout. This package does not claim that registration or verification has been completed.
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

Requests have a 20-second maximum. Safe reads retry bounded 429/5xx responses; writes retry
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
The existing discovery generator does not yet advertise OAuth service offers: do not create
an API-key offer for this package as a workaround.

API reference: <https://developers.google.com/workspace/tasks/reference/rest>.
