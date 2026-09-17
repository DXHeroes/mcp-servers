/**
 * What this client refuses to let out of a Toggl payload.
 *
 * Policy only: the keys that carry a credential, the shapes that make a value
 * safe to replace wherever it appears, and the floor under a discovered secret.
 * `SecretScrubber` (core) supplies the mechanism that applies them.
 */

/**
 * Response keys that must never leave this client.
 *
 * Toggl embeds the account's `api_token` in the `/me`, `/me/workspaces` and
 * `/workspaces/{id}` payloads (and in the `workspaces[]` entities nested in
 * `/me?with_related_data=true`). That token is a full credential for the
 * account, so it must never reach the model context, the transcript or the
 * host debug logs.
 *
 * `intercom_hash` (also returned by `/me`) is the user's Intercom identity
 * HMAC — enough to impersonate them in Toggl's support chat.
 *
 * `ical_url` is on every workspace payload (Toggl's own API definition carries
 * it on the workspace models next to `api_token`). It is a capability URL —
 * `/ical/workspace_user/{secret}` — that serves the workspace user's calendar
 * of time entries to anyone holding it, with no authentication. Toggl offers a
 * reset for it, which is what makes it a credential rather than a link.
 *
 * No tool has a legitimate use for any of the three. See
 * the connector redaction policy.
 */
export const REDACTED_KEY_STEMS: readonly string[] = ['api_token', 'intercom_hash', 'ical_url'];

/**
 * Shape of a real Toggl API token: 32 hex characters.
 *
 * Value scrubbing replaces the token wherever it appears, so it is only safe
 * for a string that cannot plausibly *be* legitimate data. A misconfigured or
 * placeholder token ("Marketing", "20240115") occurs verbatim in client names
 * and timestamps, and replacing it there corrupts the payload while leaving it
 * syntactically valid — a mangled `start` a model may well send back into an
 * update. So: token-shaped tokens are scrubbed by value, anything else is not,
 * and the constructor says so out loud rather than degrading silently.
 */
export const TOGGL_TOKEN_PATTERN = /^[0-9a-f]{32}$/i;

/**
 * Toggl's unauthenticated calendar capability URL: `/ical/workspace_user/{secret}`.
 *
 * Scrubbed by pattern, not only by key, because the client never learns the
 * secret of a URL it did not fetch: users paste their calendar feed into a
 * project or time entry description (it is a share link), and
 * `toggl_list_time_entries` would then hand it to the model and to the debug
 * logs as ordinary free text.
 */
export const ICAL_PATH_PATTERN = /\/ical\/workspace_user\/([A-Za-z0-9._~-]+)/g;

/**
 * Shortest string still scrubbed by value — a floor for the secrets discovered
 * inside a payload (an ical secret, a value under a redacted key), so a stub
 * value cannot mangle unrelated text.
 */
export const MIN_SCRUBBED_SECRET_LENGTH = 8;
