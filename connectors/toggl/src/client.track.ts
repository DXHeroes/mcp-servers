/**
 * Track API v9 endpoints — user, workspaces, time entries, projects and their
 * members, clients, tags and tasks.
 *
 * Split out of `client.ts`, which keeps the Reports API v3 half and the public
 * surface. Every method here is the one it always was; `TogglClient` extends
 * this class, so no caller and no import path changed.
 */

import { taskHintContext } from './client.hints.js';
import { TogglHttpClient } from './client.http.js';
import {
  compactList,
  DEFAULT_PROJECTS_PER_PAGE,
  DEFAULT_TIME_ENTRY_LIMIT,
  MAX_TIME_ENTRY_LIMIT,
  projectsEnvelope,
  timeEntriesEnvelope,
} from './client.payload.js';
// Imported rather than duplicated: the narrowed request types must quote
// exactly the values the input schema accepts.
import {
  type ClientStatus,
  DEFAULT_TIME_ENTRY_DELETION_MODE,
  type TimeEntryDeletionMode,
} from './schemas.js';

/**
 * Value sent as `created_with` on every time entry we create.
 *
 * Toggl requires the field, but it identifies *this* integration — it is not a
 * caller's decision, so it is not part of any tool's input schema.
 */
const CREATED_WITH = 'mcp-toggl';

export class TogglTrackClient extends TogglHttpClient {
  // ── User & Workspace ────────────────────────────────────────────────

  async me(params: { with_related_data?: boolean }): Promise<unknown> {
    return this.track('GET', '/me', params as Record<string, boolean | undefined>);
  }

  async listWorkspaces(): Promise<unknown> {
    return this.track('GET', '/me/workspaces');
  }

  async getWorkspace(params: { workspace_id: number }): Promise<unknown> {
    return this.track('GET', `/workspaces/${params.workspace_id}`);
  }

  // ── Time Entries ────────────────────────────────────────────────────

  /**
   * Lists the caller's time entries, with names alongside the ids.
   *
   * `meta=true` is always sent. Every entry carries `project_id`, `task_id`
   * and `client_id` and nothing else identifying, so answering "what did I
   * work on last week" used to cost a second round trip to
   * `toggl_list_projects` purely as a lookup table — on an endpoint Toggl
   * throttles harder than any other, and against a rate limit of about one
   * request per second.
   *
   * Toggl's own API definition documents the parameter on this endpoint
   * ("Should the response contain data for meta entities") and its time entry
   * model carries `project_name`, `client_name`, `task_name` and
   * `workspace_name`; the Raycast Toggl Track extension and several
   * independent clients send it the same way. It costs no extra request, so
   * it is not a parameter — a caller has no reason to ask for ids without the
   * names that make them readable.
   */
  async listTimeEntries(params: {
    start_date?: string;
    end_date?: string;
    limit?: number;
  }): Promise<unknown> {
    const { limit, ...query } = params;
    const effectiveLimit = Math.min(limit ?? DEFAULT_TIME_ENTRY_LIMIT, MAX_TIME_ENTRY_LIMIT);
    const payload = await this.track('GET', '/me/time_entries', {
      ...(query as Record<string, string | undefined>),
      meta: true,
    });
    return compactList(payload, (items) => timeEntriesEnvelope(items, effectiveLimit));
  }

  /**
   * Loads the running timer.
   *
   * Deliberately **not** given `meta=true`. Two independent mirrors of Toggl's
   * API definition list no query parameters at all for this endpoint, and the
   * Raycast extension — which does send `meta=true` on the listing above —
   * works around its absence here by matching the running entry against the
   * listing to recover the names. Sending an unverified parameter that may be
   * ignored would put a promise in the tool description that Toggl has not
   * made, so the description points at `toggl_list_time_entries` instead.
   */
  async getCurrentTimeEntry(): Promise<unknown> {
    return this.track('GET', '/me/time_entries/current');
  }

  async createTimeEntry(params: {
    workspace_id: number;
    description?: string;
    project_id?: number;
    task_id?: number;
    start: string;
    duration: number;
    tags?: string[];
    billable?: boolean;
  }): Promise<unknown> {
    const { workspace_id, ...body } = params;
    return this.track(
      'POST',
      `/workspaces/${workspace_id}/time_entries`,
      undefined,
      {
        workspace_id,
        ...body,
        created_with: CREATED_WITH,
      },
      // The path says nothing about tasks, so without this a 403 caused by
      // `task_id` on a free workspace would never mention the paid feature.
      taskHintContext(params.task_id),
    );
  }

  async updateTimeEntry(params: {
    workspace_id: number;
    time_entry_id: number;
    description?: string;
    project_id?: number | null;
    task_id?: number | null;
    start?: string;
    duration?: number;
    tags?: string[];
    billable?: boolean;
  }): Promise<unknown> {
    const { workspace_id, time_entry_id, ...body } = params;
    return this.track(
      'PUT',
      `/workspaces/${workspace_id}/time_entries/${time_entry_id}`,
      undefined,
      body,
      taskHintContext(params.task_id),
    );
  }

  async stopTimeEntry(params: { workspace_id: number; time_entry_id: number }): Promise<unknown> {
    return this.track(
      'PATCH',
      `/workspaces/${params.workspace_id}/time_entries/${params.time_entry_id}/stop`,
    );
  }

  async deleteTimeEntry(params: { workspace_id: number; time_entry_id: number }): Promise<unknown> {
    return this.track(
      'DELETE',
      `/workspaces/${params.workspace_id}/time_entries/${params.time_entry_id}`,
    );
  }

  // ── Projects ────────────────────────────────────────────────────────

  /**
   * Lists projects, one page at a time.
   *
   * `per_page` defaults to {@link DEFAULT_PROJECTS_PER_PAGE} rather than being
   * left off. Toggl paginates the endpoint but applies no default, so an
   * unparameterised call on a workspace of a few hundred projects returned on
   * the order of 190,000 characters in one go. Paging is not documented in
   * Toggl's machine-readable definition for this endpoint, but four
   * independent clients drive it with `page`/`per_page` — hence a default and
   * an envelope that does not claim to know how many pages remain.
   */
  async listProjects(params: {
    workspace_id: number;
    active?: boolean;
    page?: number;
    per_page?: number;
  }): Promise<unknown> {
    const { workspace_id, ...query } = params;
    const perPage = query.per_page ?? DEFAULT_PROJECTS_PER_PAGE;
    const page = query.page ?? 1;
    const payload = await this.track('GET', `/workspaces/${workspace_id}/projects`, {
      ...query,
      per_page: perPage,
      page,
    } as Record<string, string | number | boolean | undefined>);
    return compactList(payload, (items) => projectsEnvelope(items, page, perPage));
  }

  async getProject(params: { workspace_id: number; project_id: number }): Promise<unknown> {
    return this.track('GET', `/workspaces/${params.workspace_id}/projects/${params.project_id}`);
  }

  async createProject(params: {
    workspace_id: number;
    name: string;
    client_id?: number;
    active?: boolean;
    billable?: boolean;
    color?: string;
    is_private?: boolean;
  }): Promise<unknown> {
    const { workspace_id, ...body } = params;
    return this.track('POST', `/workspaces/${workspace_id}/projects`, undefined, body);
  }

  async updateProject(params: {
    workspace_id: number;
    project_id: number;
    name?: string;
    client_id?: number | null;
    active?: boolean;
    billable?: boolean;
    color?: string;
  }): Promise<unknown> {
    const { workspace_id, project_id, ...body } = params;
    return this.track('PUT', `/workspaces/${workspace_id}/projects/${project_id}`, undefined, body);
  }

  /**
   * Deletes a project.
   *
   * `teDeletionMode` is a query parameter of this endpoint documented as
   * "Time entries deletion mode: 'delete' or 'unassign'". What Toggl does when
   * it is **omitted** is not documented anywhere we could find, and we have no
   * account to test it against — so the client never omits it.
   *
   * The default is the non-destructive value: without an explicit
   * `'delete'` from the caller the tracked time is asked to survive. If Toggl
   * were to ignore the parameter entirely, this is still the outcome we would
   * have asked for; the reverse choice would silently destroy billing history.
   * `flying-lama/toggl-client` and `CorrectRoadH/OpenTickly` hardcode the same
   * default.
   */
  async deleteProject(params: {
    workspace_id: number;
    project_id: number;
    teDeletionMode?: TimeEntryDeletionMode;
  }): Promise<unknown> {
    const { workspace_id, project_id } = params;
    const teDeletionMode = params.teDeletionMode ?? DEFAULT_TIME_ENTRY_DELETION_MODE;
    return this.track('DELETE', `/workspaces/${workspace_id}/projects/${project_id}`, {
      teDeletionMode,
    });
  }

  // ── Project members ─────────────────────────────────────────────────

  async listWorkspaceUsers(params: {
    workspace_id: number;
    exclude_deleted?: boolean;
  }): Promise<unknown> {
    const { workspace_id, exclude_deleted } = params;
    return this.track('GET', `/workspaces/${workspace_id}/users`, { exclude_deleted });
  }

  /** Toggl takes `project_ids` as one comma-separated query value. */
  async listProjectUsers(params: {
    workspace_id: number;
    project_ids?: number[];
    user_id?: number;
    with_group_members?: boolean;
  }): Promise<unknown> {
    const { workspace_id, project_ids, user_id, with_group_members } = params;
    return this.track('GET', `/workspaces/${workspace_id}/project_users`, {
      project_ids: project_ids?.join(','),
      user_id,
      with_group_members,
    });
  }

  async addProjectUser(params: {
    workspace_id: number;
    project_id: number;
    user_id: number;
    manager?: boolean;
  }): Promise<unknown> {
    const { workspace_id, ...body } = params;
    return this.track('POST', `/workspaces/${workspace_id}/project_users`, undefined, body);
  }

  // ── Clients ─────────────────────────────────────────────────────────

  async listClients(params: {
    workspace_id: number;
    status?: ClientStatus;
    name?: string;
  }): Promise<unknown> {
    const { workspace_id, ...query } = params;
    return this.track(
      'GET',
      `/workspaces/${workspace_id}/clients`,
      query as Record<string, string | undefined>,
    );
  }

  async createClient(params: {
    workspace_id: number;
    name: string;
    notes?: string;
  }): Promise<unknown> {
    const { workspace_id, ...body } = params;
    return this.track('POST', `/workspaces/${workspace_id}/clients`, undefined, body);
  }

  async updateClient(params: {
    workspace_id: number;
    client_id: number;
    name?: string;
    notes?: string;
  }): Promise<unknown> {
    const { workspace_id, client_id, ...body } = params;
    return this.track('PUT', `/workspaces/${workspace_id}/clients/${client_id}`, undefined, body);
  }

  async getClient(params: { workspace_id: number; client_id: number }): Promise<unknown> {
    return this.track('GET', `/workspaces/${params.workspace_id}/clients/${params.client_id}`);
  }

  async deleteClient(params: { workspace_id: number; client_id: number }): Promise<unknown> {
    return this.track('DELETE', `/workspaces/${params.workspace_id}/clients/${params.client_id}`);
  }

  async archiveClient(params: { workspace_id: number; client_id: number }): Promise<unknown> {
    return this.track(
      'POST',
      `/workspaces/${params.workspace_id}/clients/${params.client_id}/archive`,
    );
  }

  /**
   * Restores an archived client.
   *
   * Toggl documents the endpoint as "restores client and all related or
   * specified projects" and its request body as `{ projects?: number[],
   * restore_all_projects?: boolean }`. Archiving a client archives its
   * projects too, so a restore without `restore_all_projects: true` brings
   * back the client alone — the body is only sent when the caller asks for it.
   */
  async restoreClient(params: {
    workspace_id: number;
    client_id: number;
    restore_all_projects?: boolean;
  }): Promise<unknown> {
    const { workspace_id, client_id, restore_all_projects } = params;
    return this.track(
      'POST',
      `/workspaces/${workspace_id}/clients/${client_id}/restore`,
      undefined,
      restore_all_projects === undefined ? undefined : { restore_all_projects },
    );
  }

  // ── Tags ────────────────────────────────────────────────────────────

  async listTags(params: { workspace_id: number }): Promise<unknown> {
    return this.track('GET', `/workspaces/${params.workspace_id}/tags`);
  }

  async createTag(params: { workspace_id: number; name: string }): Promise<unknown> {
    const { workspace_id, ...body } = params;
    return this.track('POST', `/workspaces/${workspace_id}/tags`, undefined, body);
  }

  async updateTag(params: {
    workspace_id: number;
    tag_id: number;
    name: string;
  }): Promise<unknown> {
    const { workspace_id, tag_id, ...body } = params;
    return this.track('PUT', `/workspaces/${workspace_id}/tags/${tag_id}`, undefined, body);
  }

  async deleteTag(params: { workspace_id: number; tag_id: number }): Promise<unknown> {
    return this.track('DELETE', `/workspaces/${params.workspace_id}/tags/${params.tag_id}`);
  }

  // ── Tasks ───────────────────────────────────────────────────────────

  /**
   * Lists tasks, either across the workspace or within a single project.
   *
   * Toggl exposes two endpoints and they are not equivalent:
   *
   * - `GET /workspaces/{ws}/tasks` is paginated (50 per page by default) and
   *   accepts `active` plus a `search` term.
   * - `GET /workspaces/{ws}/projects/{project_id}/tasks` returns every task of
   *   one project and accepts `active` only.
   *
   * `project_id` selects the project-scoped endpoint. Paging and `search` do
   * not apply there and are not sent.
   */
  async listTasks(params: {
    workspace_id: number;
    project_id?: number;
    active?: boolean;
    search?: string;
    page?: number;
    per_page?: number;
  }): Promise<unknown> {
    const { workspace_id, project_id, active, search, page, per_page } = params;
    if (project_id !== undefined) {
      return this.track('GET', `/workspaces/${workspace_id}/projects/${project_id}/tasks`, {
        active,
      });
    }
    return this.track('GET', `/workspaces/${workspace_id}/tasks`, {
      active,
      search,
      page,
      per_page,
    });
  }

  async getTask(params: {
    workspace_id: number;
    project_id: number;
    task_id: number;
  }): Promise<unknown> {
    return this.track(
      'GET',
      `/workspaces/${params.workspace_id}/projects/${params.project_id}/tasks/${params.task_id}`,
    );
  }

  async createTask(params: {
    workspace_id: number;
    project_id: number;
    name: string;
    active?: boolean;
    estimated_seconds?: number;
    external_reference?: string;
    user_id?: number;
  }): Promise<unknown> {
    const { workspace_id, project_id, ...body } = params;
    return this.track(
      'POST',
      `/workspaces/${workspace_id}/projects/${project_id}/tasks`,
      undefined,
      body,
    );
  }

  async updateTask(params: {
    workspace_id: number;
    project_id: number;
    task_id: number;
    name?: string;
    active?: boolean;
    estimated_seconds?: number;
    external_reference?: string;
    user_id?: number;
  }): Promise<unknown> {
    const { workspace_id, project_id, task_id, ...body } = params;
    return this.track(
      'PUT',
      `/workspaces/${workspace_id}/projects/${project_id}/tasks/${task_id}`,
      undefined,
      body,
    );
  }

  async deleteTask(params: {
    workspace_id: number;
    project_id: number;
    task_id: number;
  }): Promise<unknown> {
    return this.track(
      'DELETE',
      `/workspaces/${params.workspace_id}/projects/${params.project_id}/tasks/${params.task_id}`,
    );
  }
}
