/**
 * Remediation hints — what the caller should *do* about a failed Toggl request.
 *
 * Split out of `client.ts`: the mapping from an upstream failure to an
 * actionable remedy is a body of policy in its own right, and nothing here
 * touches the network. Re-exported from `./client.js`.
 */

import type { RateLimitWaitSource } from '@dxheroes/mcp-kit';
import type { TogglErrorCode } from './client.errors.js';
import { describeWait } from './client.pacing.js';
// Imported rather than duplicated: the remediation hints below must quote
// exactly the values the input schema accepts.
import {
  CLIENT_STATUS_VALUES,
  KNOWN_REPORT_GROUPINGS,
  KNOWN_REPORT_SUB_GROUPINGS,
} from './schemas.js';

/**
 * Date/time formats Toggl accepts, quoted in remediation hints.
 *
 * The Track API takes RFC 3339 timestamps for time entry `start`/`stop`; the
 * Reports API takes date-only values for `start_date`/`end_date`.
 */
const TRACK_TIMESTAMP_EXAMPLE = '2024-01-15T09:00:00Z';

const REPORT_DATE_EXAMPLE = '2024-01-15';

/**
 * Words that mean the failing request got a date or a duration wrong.
 *
 * The position of the word inside a snake_case identifier is the whole point,
 * in both directions.
 *
 * A date word may not sit *after* an underscore: `\b` fails on the `_` in
 * `week_start` and `Front_end`, so a tag or project whose name merely ends in
 * a date word collects no hint about timestamp formats. Flattening `_` to a
 * space, which an earlier version did, erased that difference.
 *
 * It may not carry an arbitrary suffix either, which the version after that
 * allowed with `(?:_[a-z0-9]+)*`. That matched any identifier merely
 * *beginning* with a date word, so `Name has already been taken: start_2024`
 * and `end_customer_id is invalid` were both answered with a lecture on RFC
 * 3339. Only the suffixes that actually make a field temporal are accepted —
 * the ones Toggl names its own request fields with (`start_date`, `end_date`,
 * `start_time`, `duration_seconds`).
 */
const DATE_FIELD_PATTERN =
  /\b(?:date|timestamp|duration|start|stop|end)(?:_(?:date|time|at|day|seconds|timestamp))?\b/;

/**
 * Describes how a time entry request referenced a task, for hint selection.
 * `undefined` means the request said nothing about tasks at all.
 */
export function taskHintContext(taskId: number | null | undefined): ErrorHintContext | undefined {
  if (taskId === undefined) return undefined;
  return { taskReference: taskId === null ? 'clear' : 'assign' };
}

/**
 * Whether an error message is complaining about a *reference* to an entity
 * rather than about one of that entity's own attributes.
 *
 * `extractErrorMessage`'s leaf fallback labels a validation failure with the
 * field it hangs under, so `{"errors":{"project_name":["is too long"]}}`
 * arrives as `project_name: is too long`. A substring test for "project" saw
 * that and answered "use `toggl_list_projects` to look up a valid
 * `project_id`" — sending the model off to hunt for an id after being told a
 * *name* was too long, which is neither the problem nor a step towards fixing
 * it.
 *
 * The distinction is positional again: `\bprojects?\b` does not match inside
 * `project_name` (`_` is a word character), while `project_ids`, `pid` and a
 * bare "project" — the shapes an actual id complaint takes — still do.
 */
const ENTITY_REFERENCE_PATTERNS = {
  project: /\bproject_ids?\b|\bpid\b|\bprojects?\b/,
  workspace: /\bworkspace_ids?\b|\bwid\b|\bworkspaces?\b/,
  task: /\btask_ids?\b|\btid\b|\btasks?\b/,
  user: /\buser_ids?\b|\buid\b|\busers?\b/,
} as const;

function referencesEntity(
  haystack: string,
  entity: keyof typeof ENTITY_REFERENCE_PATTERNS,
): boolean {
  return ENTITY_REFERENCE_PATTERNS[entity].test(haystack);
}

/** Renders a value set for a hint: `"a", "b", "c"`. */
function quoted(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(', ');
}

/**
 * What the failing request was trying to do with a task, when that cannot be
 * read off the URL. `POST /workspaces/{ws}/time_entries` with a `task_id` is
 * the case that matters: the path says nothing about tasks, so a 403 there
 * would otherwise never mention that tasks are a paid feature.
 */
export type TaskReference = 'assign' | 'clear';

export interface ErrorHintContext {
  /** Set when the request carried a `task_id` (or asked to clear one). */
  taskReference?: TaskReference;
  /**
   * How a 429 was already handled before the caller ever saw it, so the hint
   * can say "we retried N times and it is still refusing" instead of the
   * generic "wait a moment" — advice the client has by then already followed.
   */
  rateLimit?: {
    /** Requests actually issued for this call, retries included. */
    attempts: number;
    /**
     * How long Toggl asked us to wait before the next attempt, when we could
     * work it out. Present either because `Retry-After` said so, or because the
     * fallback schedule did — {@link RateLimitWaitSource} says which, because
     * "Toggl told us" and "we guessed" are not the same claim to relay.
     */
    nextWaitMs?: number;
    waitSource?: RateLimitWaitSource;
  };
}

/**
 * Maps an upstream failure to an actionable remedy, or `undefined` when we have
 * nothing useful to add. Hints are advice for the caller, never a restatement
 * of the upstream text.
 *
 * The `path` is part of the decision, not decoration: the same word means
 * different things on different endpoints. "invalid sub_grouping projects for
 * grouping projects" is a Reports v3 complaint about grouping options, and
 * answering it with "look up a valid project_id" sends the model after a
 * parameter the report tool does not have.
 */
export function buildErrorHint(
  code: TogglErrorCode,
  message: string,
  path: string,
  context: ErrorHintContext = {},
): string | undefined {
  // Not flattened: `_` is a word character, so leaving it in place is what
  // keeps `\bend\b` from matching inside a project called `Front_end` or a tag
  // called `week_start`. The snake_case field names Toggl does complain about
  // are matched explicitly instead — see DATE_FIELD_PATTERN.
  const haystack = message.toLowerCase();
  // Reports v3 paths are `/workspace/{id}/...` (singular); every Track API
  // path is `/workspaces/{id}/...`.
  const isReportPath = path.startsWith('/workspace/');
  const isTaskPath = /\/tasks(\/|$)/.test(path);
  const isTimeEntryPath = !isReportPath && path.includes('/time_entries');
  const isClientPath = /\/clients(\/|$|\/\d+)/.test(path);
  const isClientArchivePath = /\/clients\/\d+\/(archive|restore)$/.test(path);
  const isProjectUserPath = /\/project_users(\/|$)/.test(path);
  const assignsTask = context.taskReference === 'assign';
  const clearsTask = context.taskReference === 'clear';

  if (code === 'RATE_LIMITED') {
    // This client already paces requests and already retried, so "wait a
    // moment and retry" would be advice it has just taken and exhausted. What
    // the caller needs to know is that the backlog is longer than one call can
    // sit through, and roughly how long.
    const rateLimit = context.rateLimit;
    const attempts = rateLimit?.attempts ?? 1;
    const tried =
      attempts > 1
        ? `Toggl allows roughly one request per second per API token. This client paces itself to that and already retried ${attempts - 1} time${attempts - 1 === 1 ? '' : 's'}; Toggl is still refusing.`
        : 'Toggl allows roughly one request per second per API token. This client paces itself to that, and Toggl refused anyway.';
    const wait =
      rateLimit?.nextWaitMs === undefined
        ? ' Wait before calling another Toggl tool.'
        : rateLimit.waitSource === 'retry-after'
          ? ` Toggl asked for another ${describeWait(rateLimit.nextWaitMs)}, which is longer than one tool call should block for — wait at least that long before calling another Toggl tool.`
          : ` Toggl sent no Retry-After header; wait at least ${describeWait(rateLimit.nextWaitMs)} before calling another Toggl tool.`;
    return `${tried}${wait} Issue Toggl tool calls one at a time rather than in parallel, and note that the \`/me/…\` endpoints (\`toggl_list_time_entries\`, \`toggl_get_current_time_entry\`, \`toggl_me\`) are throttled far harder than the rest of the API.`;
  }

  // A 402/403 is about the endpoint that produced it, so the plan hints are
  // per endpoint. The old code answered every 402 with a lecture about tasks.
  if ((code === 'PAYMENT_REQUIRED' || code === 'FORBIDDEN') && isClientArchivePath) {
    return 'Toggl documents client archiving and restoring as a paid-plan feature, and it also needs permission to manage this workspace. Do NOT fall back to `toggl_delete_client` — that is irreversible. Leave the client in place, or mark it dormant by renaming it with `toggl_update_client`.';
  }

  // Clearing a task is not assigning one, so it does not get the "omit
  // `task_id`" advice: the caller is already trying to detach the entry.
  if ((code === 'PAYMENT_REQUIRED' || code === 'FORBIDDEN') && clearsTask) {
    return 'Tasks are a paid Toggl Track feature (Starter plan or higher), and detaching a time entry from its task goes through the same gated endpoint. The task assignment is unchanged. Leave `task_id` out of the update to change the other fields, or move the entry to a project that uses no tasks.';
  }

  if (
    (code === 'PAYMENT_REQUIRED' || code === 'FORBIDDEN') &&
    (isTaskPath || assignsTask || (!isReportPath && referencesEntity(haystack, 'task')))
  ) {
    return 'Tasks are a paid Toggl Track feature (Starter plan or higher). Confirm the workspace is on a paid plan, or track time against a project instead of a task (omit `task_id`).';
  }

  if (code === 'PAYMENT_REQUIRED') {
    return 'The workspace plan does not cover this operation. Toggl gates several features behind paid plans (tasks, client archiving, billable rates, some report options). Check the plan of this workspace, or use a tool that does not need the paid feature.';
  }

  if (code === 'FORBIDDEN') {
    return 'The API token is valid but not allowed to perform this action. Check that the token belongs to a member of this workspace with sufficient permissions, and that the feature is included in the workspace plan.';
  }

  if (code === 'INVALID_API_KEY') {
    // Deliberately no "go and fetch a fresh token" instruction: the token lives
    // in the connector host's MCP server settings, next to every other server's
    // credentials, and that is not a surface for an agent to go rummaging in.
    // Rotating it is the operator's job; the model's job is to say so and stop.
    return 'Toggl rejected the configured API token, so no Toggl tool can work until it is replaced. Do not look for a token elsewhere and do not retry — report to the operator that the Toggl API token of this MCP server needs to be rotated.';
  }

  if (code === 'BAD_REQUEST') {
    // Ordered most specific first, and every branch that names a tool or a
    // parameter checks that the failing endpoint actually has it.
    if (isReportPath && haystack.includes('grouping')) {
      return `Reports v3 rejects this grouping. Toggl publishes no allowed set for \`grouping\`/\`sub_grouping\` and does not accept every pairing of the two; values known to work are ${quoted(KNOWN_REPORT_GROUPINGS)} for \`grouping\` and ${quoted(KNOWN_REPORT_SUB_GROUPINGS)} for \`sub_grouping\`. Retry without \`sub_grouping\`, or use \`toggl_report_detailed\` and group the returned entries yourself.`;
    }
    // Before the project branch: "Project user already exists" names a
    // project, but looking up a project_id is not what it asks for.
    if (isProjectUserPath && haystack.includes('already exists')) {
      return 'The user is already a member of this project, so there is nothing to add. Confirm with `toggl_list_project_users` filtered by `project_ids`.';
    }
    if (isProjectUserPath && referencesEntity(haystack, 'user')) {
      return 'Use `toggl_list_workspace_users` to look up a valid `user_id` (its `id` field). Only members of this workspace can be added to a project; a person outside it has to be invited by a workspace admin in Toggl first, which no tool here can do.';
    }
    if (isClientPath && haystack.includes('status')) {
      return `Valid \`status\` values are ${quoted(CLIENT_STATUS_VALUES)}.`;
    }
    if (clearsTask && referencesEntity(haystack, 'task')) {
      return "Toggl does not document `task_id` as nullable, so clearing the task of an existing time entry may simply be refused. Leave `task_id` out of the update, or set it to a task of the entry's project.";
    }
    if ((isTaskPath || isTimeEntryPath || assignsTask) && referencesEntity(haystack, 'task')) {
      return 'Use `toggl_list_tasks` to look up a valid `task_id`. A task must belong to the project given in `project_id`, and tasks are a paid Toggl feature.';
    }
    // Not gated on the path: report tools filter by `project_ids`, so a report
    // rejecting a project filter needs this hint as much as a Track write does.
    // The Reports-only meaning of "projects" (a grouping value) is already
    // answered by the grouping branch above.
    if (referencesEntity(haystack, 'project')) {
      return isReportPath
        ? 'Use `toggl_list_projects` to look up valid project IDs in this workspace. Report filters take `project_ids` as an array of numbers, and every ID must belong to `workspace_id`.'
        : 'Use `toggl_list_projects` to look up a valid `project_id` in this workspace.';
    }
    if (referencesEntity(haystack, 'workspace')) {
      return 'Use `toggl_list_workspaces` to look up a valid `workspace_id`.';
    }
    // Last, and deliberately not matching a bare "time": Toggl phrases plenty
    // of unrelated errors as "Time entry ...".
    if (DATE_FIELD_PATTERN.test(haystack)) {
      return `Check the date format. Time entry \`start\`/\`stop\` must be an RFC 3339 UTC timestamp (e.g. ${TRACK_TIMESTAMP_EXAMPLE}); report \`start_date\`/\`end_date\` must be date-only (e.g. ${REPORT_DATE_EXAMPLE}), and \`start_date\` must not be after \`end_date\`.`;
    }
    return undefined;
  }

  if (code === 'NOT_FOUND') {
    return 'The resource does not exist, or the token has no access to it. Verify the IDs with the matching list tool (e.g. `toggl_list_projects`, `toggl_list_tasks`) — IDs are workspace-scoped.';
  }

  return undefined;
}
