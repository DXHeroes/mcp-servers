/**
 * Zod input schemas for all Toggl MCP tools
 */

import { z } from 'zod';

// ── Enumerated value sets ───────────────────────────────────────────
//
// Single source of truth for the closed value sets Toggl accepts. `client.ts`
// imports these too, so a narrowed request type and a remediation hint can
// never drift from the schema that validates the input.

/** `status` filter of `GET /workspaces/{workspace_id}/clients`. */
export const CLIENT_STATUS_VALUES = ['active', 'archived', 'both'] as const;

/**
 * `grouping` / `sub_grouping` values known to work on the Reports v3 summary
 * report. These are **not** an enum: Toggl's own API definition types both
 * attributes as a free-form string and documents no allowed set, while the
 * Toggl UI also groups summaries by tasks, tags and billable status. A Zod
 * enum built from an unverifiable set would reject requests Toggl accepts, so
 * the values are only quoted — in the tool description and in the 400 hint.
 */
export const KNOWN_REPORT_GROUPINGS = ['projects', 'clients', 'users'] as const;

/** `sub_grouping` values known to work. Not every pairing is accepted. */
export const KNOWN_REPORT_SUB_GROUPINGS = [
  'time_entries',
  'projects',
  'clients',
  'users',
  'tasks',
] as const;

/**
 * `teDeletionMode` of `DELETE /workspaces/{ws}/projects/{project_id}`, which
 * Toggl documents as "Time entries deletion mode: 'delete' or 'unassign'".
 * Which one applies when the parameter is omitted is not documented, so the
 * client always sends one — see `DEFAULT_TIME_ENTRY_DELETION_MODE`.
 */
export const TIME_ENTRY_DELETION_MODES = ['delete', 'unassign'] as const;

/**
 * Sent by `TogglClient.deleteProject()` when the caller does not choose. The
 * non-destructive value: an unattended delete must not take tracked (and
 * possibly invoiced) time with it.
 */
export const DEFAULT_TIME_ENTRY_DELETION_MODE = 'unassign' as const;

export type ClientStatus = (typeof CLIENT_STATUS_VALUES)[number];
export type TimeEntryDeletionMode = (typeof TIME_ENTRY_DELETION_MODES)[number];

// ── User & Workspace ────────────────────────────────────────────────

export const MeSchema = z.object({
  with_related_data: z
    .boolean()
    .optional()
    .describe('Include related data (workspaces, clients, etc.)'),
});

export const EmptySchema = z.object({});

export const WorkspaceIdSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
});

// ── Time Entries ────────────────────────────────────────────────────

export const ListTimeEntriesSchema = z.object({
  start_date: z.string().optional().describe('Start date (ISO 8601, e.g. 2024-01-01)'),
  end_date: z.string().optional().describe('End date (ISO 8601, e.g. 2024-01-31)'),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe(
      'Maximum entries to return, default 50, max 200. This is a client-side cut: `GET /me/time_entries` offers no limit or page parameter (only since/before/start_date/end_date), so the whole response is fetched and then cut here. `has_more` and `total_received` are therefore exact about the cut — they compare what you were shown against what Toggl sent, which is not the same as what the date range contains: whether Toggl itself caps a long range is not documented and was not verified. The newest entries are kept, so move the window backwards to reach older ones rather than narrowing it towards today.',
    ),
});

export const CreateTimeEntrySchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  description: z.string().optional().describe('Time entry description'),
  project_id: z.number().int().positive().optional().describe('Project ID'),
  task_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Task ID. Must be a task of `project_id`. Required on workspaces configured with te_constraints.task_present. Tasks are a paid Toggl feature; use toggl_list_tasks to find one.',
    ),
  start: z.string().describe('Start time (ISO 8601, e.g. 2024-01-01T09:00:00Z)'),
  duration: z
    .number()
    .int()
    .describe('Duration in seconds. Use -1 for running timer (start must be current time)'),
  tags: z.array(z.string()).optional().describe('Tag names'),
  billable: z.boolean().optional().describe('Whether the entry is billable (premium feature)'),
});

export const UpdateTimeEntrySchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  time_entry_id: z.number().int().positive().describe('Time entry ID'),
  description: z.string().optional().describe('Time entry description'),
  project_id: z
    .number()
    .int()
    .positive()
    .optional()
    .nullable()
    .describe('Project ID. Toggl documents null here as unsetting the project.'),
  task_id: z
    .number()
    .int()
    .positive()
    .optional()
    .nullable()
    .describe(
      "Task ID. Must be a task of the entry's project. Toggl does not document task_id as nullable (unlike project_id), so passing null to detach the task may be rejected — it is accepted here but not promised.",
    ),
  start: z.string().optional().describe('Start time (ISO 8601)'),
  duration: z.number().int().optional().describe('Duration in seconds'),
  tags: z.array(z.string()).optional().describe('Tag names'),
  billable: z.boolean().optional().describe('Whether the entry is billable'),
});

export const StopTimeEntrySchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  time_entry_id: z.number().int().positive().describe('Time entry ID'),
});

export const DeleteTimeEntrySchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  time_entry_id: z.number().int().positive().describe('Time entry ID'),
});

// ── Projects ────────────────────────────────────────────────────────

export const ListProjectsSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  active: z.boolean().optional().describe('Filter by active status'),
  page: z.number().int().positive().optional().describe('Page number, starts at 1. Defaults to 1.'),
  per_page: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe(
      'Items per page, max 200. Defaults to 50 — a workspace with a few hundred projects answers an unbounded call with an unusably large payload.',
    ),
});

export const GetProjectSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  project_id: z.number().int().positive().describe('Project ID'),
});

export const CreateProjectSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  name: z.string().min(1).describe('Project name'),
  client_id: z.number().int().positive().optional().describe('Client ID'),
  active: z.boolean().optional().describe('Whether the project is active'),
  billable: z.boolean().optional().describe('Whether the project is billable'),
  color: z.string().optional().describe('Project color (hex, e.g. #FF0000)'),
  is_private: z
    .boolean()
    .optional()
    .describe(
      "Whether the project is private. Toggl's help centre says everyone in the workspace has access to a public project and that project members can only be added to a private one — so pass true when access should be limited to the people added with toggl_add_project_user. Omitted, Toggl's own default applies, which its API documentation does not state.",
    ),
});

export const UpdateProjectSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  project_id: z.number().int().positive().describe('Project ID'),
  name: z.string().min(1).optional().describe('Project name'),
  client_id: z.number().int().optional().nullable().describe('Client ID (null to unset)'),
  active: z.boolean().optional().describe('Whether the project is active'),
  billable: z.boolean().optional().describe('Whether the project is billable'),
  color: z.string().optional().describe('Project color (hex)'),
});

export const DeleteProjectSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  project_id: z.number().int().positive().describe('Project ID'),
  teDeletionMode: z
    .enum(TIME_ENTRY_DELETION_MODES)
    .optional()
    .describe(
      'What Toggl should do with the time entries logged against this project. "unassign" asks for them to be kept and detached from the project, "delete" asks for them to be removed with it. Omitted, this tool sends "unassign" — the non-destructive request. Toggl does not document the parameter\'s behaviour beyond those two values, so treat the outcome as a request, not a guarantee, and verify afterwards with toggl_report_detailed if the history matters.',
    ),
});

// ── Project members ─────────────────────────────────────────────────

/** Toggl answers a longer `project_ids` list with a 400. */
export const MAX_PROJECT_USER_FILTER_IDS = 200;

export const ListWorkspaceUsersSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  exclude_deleted: z
    .boolean()
    .optional()
    .describe('Leave out deleted users. Toggl documents the filter but not its default.'),
});

export const ListProjectUsersSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  project_ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_PROJECT_USER_FILTER_IDS)
    .optional()
    .describe(
      'Only list the members of these projects (at most 200). Omitted, every project membership in the workspace is listed.',
    ),
  user_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Toggl\'s description: "if passed returns only project users for this user\'s projects". The global user id, as returned by toggl_list_workspace_users.',
    ),
  with_group_members: z
    .boolean()
    .optional()
    .describe('Toggl\'s description: "Include group members".'),
});

/**
 * `POST /workspaces/{workspace_id}/project_users`. `rate`, `labor_cost` and
 * their `*_change_mode` are left out on purpose: a rate applied to all data
 * rewrites what tracked time is worth, which would make this tool not purely
 * additive. See the package AGENTS.md.
 */
export const AddProjectUserSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  project_id: z.number().int().positive().describe('Project ID'),
  user_id: z
    .number()
    .int()
    .positive()
    .describe(
      'Global user id of a workspace member — the `id` field of toggl_list_workspace_users.',
    ),
  manager: z.boolean().optional().describe('Make the user a manager of the project.'),
});

// ── Clients ─────────────────────────────────────────────────────────

export const ListClientsSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  status: z
    .enum(CLIENT_STATUS_VALUES)
    .optional()
    .describe('Filter by status. Defaults to active only when omitted.'),
  name: z.string().optional().describe('Filter by client name'),
});

export const CreateClientSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  name: z.string().min(1).describe('Client name'),
  notes: z.string().optional().describe('Notes about the client'),
});

export const UpdateClientSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  client_id: z.number().int().positive().describe('Client ID'),
  name: z.string().min(1).optional().describe('Client name'),
  notes: z.string().optional().describe('Notes about the client'),
});

export const ClientIdSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  client_id: z.number().int().positive().describe('Client ID'),
});

export const RestoreClientSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  client_id: z.number().int().positive().describe('Client ID'),
  restore_all_projects: z
    .boolean()
    .optional()
    .describe(
      'Also restore the projects that were archived together with the client. Omitted, Toggl restores the client alone and its projects stay archived.',
    ),
});

// ── Tags ────────────────────────────────────────────────────────────

export const CreateTagSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  name: z.string().min(1).describe('Tag name'),
});

export const UpdateTagSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  tag_id: z.number().int().positive().describe('Tag ID'),
  name: z.string().min(1).describe('New tag name'),
});

export const DeleteTagSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  tag_id: z.number().int().positive().describe('Tag ID'),
});

// ── Tasks ───────────────────────────────────────────────────────────

/** Filters the project-scoped task listing cannot honour. */
const PROJECT_SCOPED_UNSUPPORTED_FILTERS = ['search', 'page', 'per_page'] as const;

export const ListTasksSchema = z
  .object({
    workspace_id: z.number().int().positive().describe('Workspace ID'),
    project_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Project ID. When given, the project-scoped Toggl endpoint is used: it returns every task of that project and takes no `search` or paging, so passing those together with `project_id` is rejected instead of silently ignored.',
      ),
    active: z
      .boolean()
      .optional()
      .describe(
        "Filter by active state. Workspace-wide: true returns active tasks, false returns inactive ones. Toggl's API definition lists no query parameters at all for the project-scoped listing, so with `project_id` this filter may be ignored upstream.",
      ),
    search: z.string().optional().describe('Search by task name (workspace-wide listing only)'),
    page: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Page number, starts at 1 (workspace-wide listing only)'),
    per_page: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe('Items per page, Toggl defaults to 50 (workspace-wide listing only)'),
  })
  .superRefine((value, ctx) => {
    // The two Toggl endpoints are not interchangeable. Dropping the filters
    // that the project-scoped one cannot take would hand back an unfiltered
    // list that looks filtered — the caller must be told instead.
    if (value.project_id === undefined) return;
    for (const filter of PROJECT_SCOPED_UNSUPPORTED_FILTERS) {
      if (value[filter] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [filter],
          message: `\`${filter}\` cannot be combined with \`project_id\`: the project-scoped Toggl endpoint returns every task of the project and supports neither searching nor paging. Either drop \`project_id\` to search the whole workspace, or drop \`${filter}\`.`,
        });
      }
    }
  });

/**
 * Identifies one task. Shared by `toggl_get_task` and `toggl_delete_task`,
 * which take exactly the same three ids — like `ClientIdSchema`, one schema
 * instead of two identical ones that can drift apart.
 */
export const TaskIdSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  project_id: z.number().int().positive().describe('Project ID the task belongs to'),
  task_id: z.number().int().positive().describe('Task ID'),
});

export const CreateTaskSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  project_id: z.number().int().positive().describe('Project the task belongs to'),
  name: z.string().min(1).describe('Task name'),
  active: z.boolean().optional().describe('Whether the task is open. Pass false to mark it done.'),
  estimated_seconds: z.number().int().nonnegative().optional().describe('Estimate in seconds'),
  external_reference: z.string().optional().describe('Reference to the task in an external system'),
  user_id: z.number().int().positive().optional().describe('Assignee. Defaults to the caller.'),
});

export const UpdateTaskSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  project_id: z.number().int().positive().describe('Project the task belongs to'),
  task_id: z.number().int().positive().describe('Task ID'),
  name: z.string().min(1).optional().describe('Task name'),
  active: z.boolean().optional().describe('Whether the task is open. Pass false to mark it done.'),
  estimated_seconds: z.number().int().nonnegative().optional().describe('Estimate in seconds'),
  external_reference: z.string().optional().describe('Reference to the task in an external system'),
  user_id: z.number().int().positive().optional().describe('Assignee'),
});

// ── Reports (shared filters) ────────────────────────────────────────

const ReportFilters = {
  user_ids: z.array(z.number().int()).optional().describe('Filter by user IDs'),
  project_ids: z.array(z.number().int()).optional().describe('Filter by project IDs'),
  client_ids: z.array(z.number().int()).optional().describe('Filter by client IDs'),
  tag_ids: z.array(z.number().int()).optional().describe('Filter by tag IDs'),
  billable: z.boolean().optional().describe('Filter by billable status'),
};

export const ReportSummarySchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  start_date: z.string().min(1).describe('Start date (YYYY-MM-DD)'),
  end_date: z.string().min(1).describe('End date (YYYY-MM-DD)'),
  grouping: z
    .string()
    .min(1)
    .optional()
    .describe(
      `Top-level grouping criteria. Known to work: ${KNOWN_REPORT_GROUPINGS.join(', ')}. Toggl documents no closed set, so other values (e.g. tasks, tags) may work too and an unsupported one comes back as a 400.`,
    ),
  sub_grouping: z
    .string()
    .min(1)
    .optional()
    .describe(
      `Second-level grouping criteria. Known to work: ${KNOWN_REPORT_SUB_GROUPINGS.join(', ')}. Not every combination with \`grouping\` is accepted by Toggl.`,
    ),
  ...ReportFilters,
});

export const ReportDetailedSchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  start_date: z.string().min(1).describe('Start date (YYYY-MM-DD)'),
  end_date: z.string().min(1).describe('End date (YYYY-MM-DD)'),
  page_size: z.number().int().positive().max(200).optional().describe('Items per page (max 200)'),
  first_row_number: z.number().int().min(0).optional().describe('First row number for pagination'),
  ...ReportFilters,
});

export const ReportWeeklySchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  start_date: z.string().min(1).describe('Start date (YYYY-MM-DD)'),
  end_date: z.string().min(1).describe('End date (YYYY-MM-DD)'),
  ...ReportFilters,
});

/**
 * `POST /workspace/{workspace_id}/projects/summary` accepts a date range and
 * nothing else — it deliberately does not share `ReportFilters`. The Reports
 * v3 request body for this endpoint has no `project_ids` (or any other
 * filtering attribute), so adding one would be silently dropped upstream. Use
 * `toggl_report_summary` with `grouping: "projects"` when filters are needed.
 */
export const ReportProjectSummarySchema = z.object({
  workspace_id: z.number().int().positive().describe('Workspace ID'),
  start_date: z.string().min(1).describe('Start date (YYYY-MM-DD)'),
  end_date: z.string().min(1).describe('End date (YYYY-MM-DD)'),
});
