# Toggl Track connector

Time entries, projects and their members, clients, tags, tasks and reports through Toggl Track API
v9 and Reports v3.

## Credential and deployment

Use the 32-character Toggl API token from the profile page as
`MCP_UPSTREAM_CREDENTIAL[_FILE]`, with a distinct connector bearer in `MCP_ACCESS_TOKEN[_FILE]`.
The token inherits the user's workspace permissions. Tasks and client archive/restore require a
paid Toggl plan.

```sh
docker build -f Dockerfile.connector --build-arg CONNECTOR=toggl -t mcp-toggl .
docker run --rm -p 127.0.0.1:8080:8080 \
  -e MCP_ACCESS_TOKEN -e MCP_UPSTREAM_CREDENTIAL \
  -e MCP_ALLOWED_HOSTS=localhost,127.0.0.1 mcp-toggl
```

## MCP surface

No resources or prompts are exposed. Tools:

- Identity/workspaces: `toggl_me`, `toggl_list_workspaces`, `toggl_get_workspace`.
- Time entries: `toggl_list_time_entries`, `toggl_get_current_time_entry`,
  `toggl_create_time_entry`, `toggl_update_time_entry`, `toggl_stop_time_entry`,
  `toggl_delete_time_entry`.
- Projects: `toggl_list_projects`, `toggl_get_project`, `toggl_create_project`,
  `toggl_update_project`, `toggl_delete_project`.
- Project members: `toggl_list_workspace_users`, `toggl_list_project_users`,
  `toggl_add_project_user`.
- Clients: `toggl_list_clients`, `toggl_get_client`, `toggl_create_client`,
  `toggl_update_client`, `toggl_archive_client`, `toggl_restore_client`,
  `toggl_delete_client`.
- Tags: `toggl_list_tags`, `toggl_create_tag`, `toggl_update_tag`, `toggl_delete_tag`.
- Tasks: `toggl_list_tasks`, `toggl_get_task`, `toggl_create_task`, `toggl_update_task`,
  `toggl_delete_task`.
- Reports: `toggl_report_summary`, `toggl_report_detailed`, `toggl_report_weekly`,
  `toggl_report_project_summary`.

Get/list/report tools are read-only. Create/start/stop/update/archive/restore tools and
`toggl_add_project_user` mutate data. Deletes and overwrites are destructive; project deletion can
also request deletion of associated time entries. Prefer project deactivation, task completion and
client archive where supported.

`toggl_create_project` accepts `is_private`. Toggl's help centre says everyone in the workspace has
access to a public project and that members can only be added to a private one, so create the
project private before adding members. `toggl_add_project_user` is annotated as an additive write
and takes only `project_id`, `user_id` (the global id from `toggl_list_workspace_users`) and
`manager`; rate and labour cost are left out because Toggl can apply a changed rate to time already
tracked. Only members of the workspace can be added; a person outside it must be invited by a
workspace admin in Toggl first. Endpoints: `GET /workspaces/{workspace_id}/users`,
`GET|POST /workspaces/{workspace_id}/project_users`
([projects](https://engineering.toggl.com/docs/track/api/projects/),
[workspaces](https://engineering.toggl.com/docs/track/api/workspaces/)).

## Limits and troubleshooting

The client paces requests at roughly one per second per token and retries bounded rate limits at
most three times, never sleeping more than 15 seconds for one retry. Time-entry lists return 50 by
default and at most 200; that endpoint has no upstream paging, so the connector keeps the newest
items and tells you when its client-side cut applied. Project pages default to 50 and allow 200, but
Toggl supplies no total/next link. A 403 can mean workspace permission or a paid-only feature, not a
bad token. Deletions have no undo; inspect the affected object first.
