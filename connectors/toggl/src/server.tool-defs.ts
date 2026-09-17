/**
 * Tool definitions for the Toggl MCP server — the 37 tools, their input
 * schemas, their MCP behaviour hints and the client call behind each one.
 *
 * Split out of `server.ts`: the catalogue is a body of description and policy
 * in its own right, while the class it came from is the protocol plumbing
 * (validate, dispatch, error shaping). Nothing here touches the network; the
 * handlers only forward to the `TogglClient` handed in.
 */

import type { ToolAnnotations } from '@dxheroes/mcp-kit';
import type { z } from 'zod';
import type { TogglClient } from './client.js';
import {
  AddProjectUserSchema,
  ClientIdSchema,
  CreateClientSchema,
  CreateProjectSchema,
  CreateTagSchema,
  CreateTaskSchema,
  CreateTimeEntrySchema,
  DeleteProjectSchema,
  DeleteTagSchema,
  DeleteTimeEntrySchema,
  EmptySchema,
  GetProjectSchema,
  ListClientsSchema,
  ListProjectsSchema,
  ListProjectUsersSchema,
  ListTasksSchema,
  ListTimeEntriesSchema,
  ListWorkspaceUsersSchema,
  MeSchema,
  ReportDetailedSchema,
  ReportProjectSummarySchema,
  ReportSummarySchema,
  ReportWeeklySchema,
  RestoreClientSchema,
  StopTimeEntrySchema,
  TaskIdSchema,
  UpdateClientSchema,
  UpdateProjectSchema,
  UpdateTagSchema,
  UpdateTaskSchema,
  UpdateTimeEntrySchema,
  WorkspaceIdSchema,
} from './schemas.js';

/**
 * MCP behaviour hints attached to every tool.
 *
 * The connector host sorts tools into read-only, write and destructive tiers
 * by `readOnlyHint` and `destructiveHint`
 * (`packages/kit/src/utils/tool-classification.ts`) and gives each tier its
 * own ALLOW / NEEDS_APPROVAL / BLOCKED setting. With no annotations all 37
 * tools land in the write group — the 18 read-only ones included — and an
 * operator has no way to say "allow the listings, ask before the deletes".
 *
 * This package deliberately restricts nothing itself; these hints are what
 * makes restricting possible one layer up. Per the MCP spec they are hints,
 * not a security boundary.
 */
const READ_ONLY_TOOL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Additive: creates a record, or changes one in a way that loses nothing.
 *
 * Not "nothing that cannot be set again" — that used to be the claim here and
 * it was wrong for the update family, which overwrites values Toggl does not
 * keep a history of. The whole update family carries `DESTRUCTIVE_TOOL`
 * instead; what is left here is the genuinely additive set (the creates,
 * `toggl_add_project_user`, `toggl_stop_time_entry`, `toggl_restore_client`).
 */
const WRITE_TOOL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

/**
 * Destructive in the MCP sense: the change is not purely additive.
 *
 * That covers the deletes, and it also covers an overwrite of data Toggl keeps
 * no history of (the previous `start` of a time entry is not just unrecoverable
 * but unknowable) and a change that fans out across records (renaming a tag
 * rewrites it on every entry carrying it, workspace-wide).
 *
 * The connector host reads this: `destructiveHint` puts a tool in its own permission
 * group, so an operator can leave writes on ALLOW and still hold these at
 * NEEDS_APPROVAL. Setting it truthfully is what makes that switch mean
 * anything.
 *
 * The flag is also not a ranking. `toggl_update_client` and
 * `toggl_archive_client` are both destructive *and* the recommended
 * alternatives to `toggl_delete_client`, because "not purely additive" is one
 * bit and "how much is at stake" is not. Where a destructive tool is the
 * safest way to reach an intent, its description says so rather than leaving
 * the model to read the annotation as a warning against it.
 */
const DESTRUCTIVE_TOOL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
};

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  annotations: ToolAnnotations;
  handler: (args: unknown) => Promise<unknown>;
}

/**
 * Build the tool catalogue against one client instance.
 *
 * Called once per initialized server; every handler closes over `c`.
 */
export function buildTogglToolDefs(c: TogglClient): ToolDef[] {
  return [
    // ── User & Workspace ──────────────────────────────────────────
    {
      name: 'toggl_me',
      description:
        'Get current user profile. Optionally include related data (workspaces, clients, projects) — doing so in one call is cheaper than several, because this is a /me/... endpoint and Toggl throttles those hardest (independent reports put them near 30 requests per hour, against roughly 1 request per second elsewhere).',
      inputSchema: MeSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.me(args as z.infer<typeof MeSchema>),
    },
    {
      name: 'toggl_list_workspaces',
      description:
        'List all workspaces the authenticated user belongs to. A /me/... endpoint, which Toggl throttles hardest (independent reports put those near 30 requests per hour), so cache the ids for the rest of the conversation instead of re-listing.',
      inputSchema: EmptySchema,
      annotations: READ_ONLY_TOOL,
      handler: () => c.listWorkspaces(),
    },
    {
      name: 'toggl_get_workspace',
      description: 'Get details of a specific workspace by ID.',
      inputSchema: WorkspaceIdSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.getWorkspace(args as z.infer<typeof WorkspaceIdSchema>),
    },

    // ── Time Entries ──────────────────────────────────────────────
    {
      name: 'toggl_list_time_entries',
      description:
        "List time entries for the current user, most recent first. Optionally filter by date range (start_date/end_date). Entries are requested with Toggl's meta expansion, so they normally carry project_name, client_name and task_name alongside the ids and no lookup call is needed; a name that is absent means Toggl did not send it, which is not the same as the project having no name. Entries come from every workspace the user belongs to — this endpoint has no workspace filter — so check workspace_id on each entry when only one workspace is of interest. Returns at most 50 entries by default (max 200 via limit) and reports has_more; the cut is client-side (Toggl offers no limit or page here) and keeps the newest, so move the window backwards to reach older entries rather than narrowing it towards today. Keys whose value is null are dropped from each entry, so a missing key means null or never sent. This endpoint is one Toggl throttles hardest (independent reports put /me/... near 30 requests per hour), so prefer one wide range over several narrow calls.",
      inputSchema: ListTimeEntriesSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listTimeEntries(args as z.infer<typeof ListTimeEntriesSchema>),
    },
    {
      name: 'toggl_get_current_time_entry',
      description:
        'Get the currently running time entry, or null if no timer is running. Unlike toggl_list_time_entries this returns ids only — Toggl documents no way to ask this endpoint for project, client or task names — so resolve them with toggl_list_time_entries over a range covering today, or with toggl_get_project. Both this and toggl_list_time_entries hit /me/..., which Toggl throttles hardest (independent reports put it near 30 requests per hour), so answering "what am I working on, and on which project" costs two of that budget: only look the name up when it is actually needed.',
      inputSchema: EmptySchema,
      annotations: READ_ONLY_TOOL,
      handler: () => c.getCurrentTimeEntry(),
    },
    {
      name: 'toggl_create_time_entry',
      description:
        'Create a new time entry. Set duration to -1 and start to the current time to start a running timer; start must be an RFC 3339 UTC timestamp such as 2024-01-15T09:00:00Z. task_id is optional and must be a task of project_id — find one with toggl_list_tasks; tasks are a paid Toggl feature, and workspaces configured with te_constraints.task_present reject an entry that has none. The created_with marker is set by this integration and is not a parameter.',
      inputSchema: CreateTimeEntrySchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createTimeEntry(args as z.infer<typeof CreateTimeEntrySchema>),
    },
    {
      name: 'toggl_update_time_entry',
      description:
        'DESTRUCTIVE: overwrites the fields you pass on an existing time entry. Toggl keeps no history of a time entry, so the previous description, start or duration is not just irreversible but unknowable afterwards — read the entry first (toggl_list_time_entries, toggl_get_current_time_entry) if the old value matters, and pass only the fields you mean to change. Only provided fields are updated; start takes an RFC 3339 UTC timestamp. project_id accepts null to unassign the project, which Toggl documents. task_id is not documented as nullable: null is accepted here as a best effort to detach the task, but Toggl may reject it — if it does, the task stays assigned rather than the request having asked for a different task.',
      inputSchema: UpdateTimeEntrySchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => c.updateTimeEntry(args as z.infer<typeof UpdateTimeEntrySchema>),
    },
    {
      name: 'toggl_stop_time_entry',
      description: 'Stop a currently running time entry.',
      inputSchema: StopTimeEntrySchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.stopTimeEntry(args as z.infer<typeof StopTimeEntrySchema>),
    },
    {
      name: 'toggl_delete_time_entry',
      description:
        'DESTRUCTIVE: permanently deletes a time entry. Toggl has no undo and no recycle bin, and the entry disappears from every report — including invoicing and billable totals already based on it. There is no archive for time entries: to correct one, call toggl_update_time_entry (change description, project, task, tags, start or duration), or toggl_stop_time_entry if the problem is a timer still running.',
      inputSchema: DeleteTimeEntrySchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => c.deleteTimeEntry(args as z.infer<typeof DeleteTimeEntrySchema>),
    },

    // ── Projects ──────────────────────────────────────────────────
    {
      name: 'toggl_list_projects',
      description:
        'List projects in a workspace, optionally filtered by active status. Paginated: returns 50 per page by default (per_page up to 200, page starts at 1) because an unbounded call on a large workspace returns an unusably long response. The result reports returned, page, per_page and possibly_more_pages. Both values of that flag are inference, not fact: Toggl sends no total and no next-page link, so a full page only suggests more remain, and a short page only suggests the end — a per_page Toggl quietly capped would look the same. Keys whose value is null are dropped from each project, so a missing key means null or never sent.',
      inputSchema: ListProjectsSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listProjects(args as z.infer<typeof ListProjectsSchema>),
    },
    {
      name: 'toggl_get_project',
      description: 'Get details of a specific project.',
      inputSchema: GetProjectSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.getProject(args as z.infer<typeof GetProjectSchema>),
    },
    {
      name: 'toggl_create_project',
      description:
        "Create a new project in a workspace. Pass is_private: true when only chosen people should see and track time on it, then add them with toggl_add_project_user; Toggl's help centre says everyone in the workspace has access to a public project. Omitted, Toggl applies its own default, which its API documentation does not state.",
      inputSchema: CreateProjectSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createProject(args as z.infer<typeof CreateProjectSchema>),
    },
    {
      name: 'toggl_update_project',
      description:
        'DESTRUCTIVE: overwrites the fields you pass on an existing project. Toggl keeps no history of a project, so the previous name, client assignment, colour or billable flag is unknowable afterwards — read it first with toggl_get_project if the old value matters, and pass only the fields you mean to change. Only provided fields are updated; client_id accepts null to unassign the client. This is still the safe way to retire a project: active: false hides it from the active lists while every time entry tracked against it survives, which toggl_delete_project cannot promise.',
      inputSchema: UpdateProjectSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => c.updateProject(args as z.infer<typeof UpdateProjectSchema>),
    },

    {
      name: 'toggl_delete_project',
      description:
        'DESTRUCTIVE: permanently deletes a project. Toggl has no undo. The time already tracked against the project is at stake: this tool sends teDeletionMode "unassign", which asks Toggl to keep those time entries and only detach them from the project; pass teDeletionMode "delete" to ask for them to be removed together with the project. Toggl documents the two values but not what it does when the parameter is absent, so treat the outcome as requested rather than guaranteed and check afterwards with toggl_report_detailed if the tracked time matters. To retire a project without deleting anything, call toggl_update_project with active: false instead.',
      inputSchema: DeleteProjectSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => c.deleteProject(args as z.infer<typeof DeleteProjectSchema>),
    },

    // ── Project members ───────────────────────────────────────────
    {
      name: 'toggl_list_workspace_users',
      description:
        'List the users of a workspace with their global user id, email, fullname and role, plus is_active (has joined the workspace) and inactive (deactivated). That id is the user_id toggl_add_project_user and toggl_list_project_users take. Only people listed here can be added to a project: someone outside the workspace has to be invited by a workspace admin in Toggl first, and no tool here sends invitations.',
      inputSchema: ListWorkspaceUsersSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listWorkspaceUsers(args as z.infer<typeof ListWorkspaceUsersSchema>),
    },
    {
      name: 'toggl_list_project_users',
      description:
        'List project memberships in a workspace: which user_id belongs to which project_id, and whether that user manages the project. Filter with project_ids (up to 200) or user_id — without a filter every membership in the workspace comes back. Names are not included; resolve user_id with toggl_list_workspace_users. Check here before toggl_add_project_user, because Toggl rejects adding someone who is already a member.',
      inputSchema: ListProjectUsersSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listProjectUsers(args as z.infer<typeof ListProjectUsersSchema>),
    },
    {
      name: 'toggl_add_project_user',
      description:
        'Add a workspace member to a project, optionally as its manager. Purely additive: it grants access and changes nothing already tracked. user_id must belong to a member of this workspace (toggl_list_workspace_users); a person outside the workspace cannot be added this way and has to be invited by a workspace admin in Toggl first. Toggl\'s help centre says members can only be added to a private project, so create the project with is_private: true. Adding someone who is already a member is answered with a 400 ("Project user already exists"). Hourly rate and labour cost are deliberately not parameters: Toggl can apply a changed rate to time already tracked.',
      inputSchema: AddProjectUserSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.addProjectUser(args as z.infer<typeof AddProjectUserSchema>),
    },

    // ── Clients ───────────────────────────────────────────────────
    {
      name: 'toggl_list_clients',
      description: 'List clients in a workspace. Optionally filter by status or name.',
      inputSchema: ListClientsSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listClients(args as z.infer<typeof ListClientsSchema>),
    },
    {
      name: 'toggl_create_client',
      description: 'Create a new client in a workspace.',
      inputSchema: CreateClientSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createClient(args as z.infer<typeof CreateClientSchema>),
    },
    {
      name: 'toggl_update_client',
      description:
        'DESTRUCTIVE: overwrites the fields you pass on an existing client. Toggl keeps no history of a client, so the previous name or notes is unknowable afterwards, and notes is free text that may be the only copy of what it says — read it first with toggl_get_client and pass only the fields you mean to change. It is still far safer than toggl_delete_client: nothing is unlinked and no project or time entry is touched, which is why renaming a client to mark it dormant is the recommended fallback when archiving is unavailable.',
      inputSchema: UpdateClientSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => c.updateClient(args as z.infer<typeof UpdateClientSchema>),
    },

    {
      name: 'toggl_get_client',
      description: 'Get details of a specific client.',
      inputSchema: ClientIdSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.getClient(args as z.infer<typeof ClientIdSchema>),
    },
    {
      name: 'toggl_archive_client',
      description:
        'DESTRUCTIVE: archiving is reversible in principle but not symmetric, so it is not a purely additive change. Toggl documents this endpoint as archiving the workspace client AND its related projects — the response lists the projects that were archived with it — so this hides the client and takes its projects out of the active lists too; no time entries are deleted. Toggl documents it as a paid-plan feature, so a free workspace can answer 403: if that happens, do NOT fall back to toggl_delete_client, which is irreversible. Reverse it with toggl_restore_client, passing restore_all_projects: true to bring the projects back as well — a plain restore returns the client alone.',
      inputSchema: ClientIdSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => c.archiveClient(args as z.infer<typeof ClientIdSchema>),
    },
    {
      name: 'toggl_restore_client',
      description:
        "Restore an archived client, making it active again. Archiving also archived the client's projects, and Toggl restores the client alone unless restore_all_projects: true is passed — so pass it when the goal is to undo a toggl_archive_client call. Like archiving, this is documented as a paid-plan feature and can answer 403 on a free workspace.",
      inputSchema: RestoreClientSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.restoreClient(args as z.infer<typeof RestoreClientSchema>),
    },
    {
      name: 'toggl_delete_client',
      description:
        'DESTRUCTIVE: permanently deletes a client. Toggl has no undo. The projects assigned to it lose their client association (the projects and their time entries survive). Prefer toggl_archive_client, which hides the client and its projects without destroying anything and can be undone with toggl_restore_client — but note archiving is a paid-plan feature, so on a free workspace it may answer 403. A 403 from archiving is not a reason to delete instead: leave the client in place, or rename it with toggl_update_client to mark it dormant.',
      inputSchema: ClientIdSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => c.deleteClient(args as z.infer<typeof ClientIdSchema>),
    },

    // ── Tags ──────────────────────────────────────────────────────
    {
      name: 'toggl_list_tags',
      description: 'List all tags in a workspace.',
      inputSchema: WorkspaceIdSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listTags(args as z.infer<typeof WorkspaceIdSchema>),
    },
    {
      name: 'toggl_create_tag',
      description: 'Create a new tag in a workspace.',
      inputSchema: CreateTagSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createTag(args as z.infer<typeof CreateTagSchema>),
    },

    {
      name: 'toggl_update_tag',
      description:
        'DESTRUCTIVE: renames a tag workspace-wide. Every time entry carrying the tag follows the new name — this is not a per-entry change and there is no undo; the old name is only recoverable by renaming it back, if it is still known. To label a subset of entries differently, create a second tag with toggl_create_tag and re-tag those entries instead.',
      inputSchema: UpdateTagSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => c.updateTag(args as z.infer<typeof UpdateTagSchema>),
    },
    {
      name: 'toggl_delete_tag',
      description:
        'DESTRUCTIVE: permanently deletes a tag and removes it from every time entry that carries it. The time entries themselves are kept. Toggl offers no archiving for tags and no undo — rename with toggl_update_tag if the tag is only misnamed.',
      inputSchema: DeleteTagSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => c.deleteTag(args as z.infer<typeof DeleteTagSchema>),
    },

    // ── Tasks ─────────────────────────────────────────────────────
    {
      name: 'toggl_list_tasks',
      description:
        'List tasks. Two different Toggl endpoints sit behind this tool. Without project_id it lists the whole workspace: paginated (Toggl defaults to 50 per page, use page and per_page) and searchable by name (search). With project_id it lists every task of that one project — that endpoint takes no search and no paging, so combining project_id with search, page or per_page is rejected as INVALID_INPUT rather than silently returning an unfiltered list. Use project_id when picking a task_id for a time entry. Tasks are a paid Toggl Track feature (Starter plan or higher); on a free workspace this returns FORBIDDEN.',
      inputSchema: ListTasksSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.listTasks(args as z.infer<typeof ListTasksSchema>),
    },
    {
      name: 'toggl_get_task',
      description:
        'Get details of a single task, including its estimate and whether it is still active. Requires the project_id the task belongs to.',
      inputSchema: TaskIdSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.getTask(args as z.infer<typeof TaskIdSchema>),
    },

    {
      name: 'toggl_create_task',
      description:
        'Create a task inside a project. Tasks are a paid Toggl Track feature (Starter plan or higher).',
      inputSchema: CreateTaskSchema,
      annotations: WRITE_TOOL,
      handler: (args) => c.createTask(args as z.infer<typeof CreateTaskSchema>),
    },
    {
      name: 'toggl_update_task',
      description:
        'DESTRUCTIVE: overwrites the fields you pass on an existing task. Toggl keeps no history of a task, so the previous name, estimate or assignee is unknowable afterwards — read it first with toggl_get_task if the old value matters, and pass only the fields you mean to change. Pass active: false to mark the task done: that closes it while keeping the task and its reporting history, which toggl_delete_task destroys.',
      inputSchema: UpdateTaskSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => c.updateTask(args as z.infer<typeof UpdateTaskSchema>),
    },
    {
      name: 'toggl_delete_task',
      description:
        'DESTRUCTIVE: permanently deletes a task. Time entries tracked against it lose their task assignment. To close a finished task while keeping the reporting history, call toggl_update_task with active: false instead.',
      inputSchema: TaskIdSchema,
      annotations: DESTRUCTIVE_TOOL,
      handler: (args) => c.deleteTask(args as z.infer<typeof TaskIdSchema>),
    },

    // ── Reports ───────────────────────────────────────────────────
    {
      name: 'toggl_report_summary',
      description:
        'Get a summary report of time entries over a date range, with optional user, project, client, tag and billable filters. grouping and sub_grouping are free-form strings in Toggl\'s API: "projects", "clients" and "users" are known to work for grouping, and "time_entries", "projects", "clients", "users", "tasks" for sub_grouping, but Toggl publishes no closed set and rejects unsupported values (or unsupported pairings of the two) with a 400. Dates are date-only, e.g. 2024-01-15.',
      inputSchema: ReportSummarySchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.reportSummary(args as z.infer<typeof ReportSummarySchema>),
    },
    {
      name: 'toggl_report_detailed',
      description:
        'Get a detailed report of individual time entries across the whole workspace, including other users. Rows already carry project_name, client_name, task_name and username alongside the ids, so no lookup call is needed. Paginated: page_size defaults to 50 upstream, and first_row_number continues from a previous page. Dates are date-only, e.g. 2024-01-15.',
      inputSchema: ReportDetailedSchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.reportDetailed(args as z.infer<typeof ReportDetailedSchema>),
    },
    {
      name: 'toggl_report_weekly',
      description:
        'Get a weekly report of time entries. Each row carries an unlabelled `seconds` array — Toggl returns no dates with it and offers no parameter to anchor it, so do not assume which day an element belongs to. When per-day totals must be attributed to specific dates, use toggl_report_detailed and group the returned entries by their own timestamps.',
      inputSchema: ReportWeeklySchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.reportWeekly(args as z.infer<typeof ReportWeeklySchema>),
    },
    {
      name: 'toggl_report_project_summary',
      description:
        'Get a project summary report with total tracked time per project in a date range.',
      inputSchema: ReportProjectSummarySchema,
      annotations: READ_ONLY_TOOL,
      handler: (args) => c.reportProjectSummary(args as z.infer<typeof ReportProjectSummarySchema>),
    },
  ];
}
