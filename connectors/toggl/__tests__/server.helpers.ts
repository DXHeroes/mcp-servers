/**
 * Shared setup for the TogglMcpServer unit tests.
 *
 * Not a `.test.` file, so Vitest does not pick it up as a suite. Each split
 * test file keeps its own `vi.mock('../src/client.js')` call — those are
 * hoisted per module and cannot be shared — and delegates the mocked module
 * shape to `createTogglClientMock` here, so the mock surface exists once.
 */

import type { ApiKeyConfig } from '@dxheroes/mcp-kit';
import { vi } from 'vitest';

// Mock the TogglClient
export const mockValidateApiKey = vi.fn();
export const mockMe = vi.fn();
export const mockListWorkspaces = vi.fn();
export const mockGetWorkspace = vi.fn();
export const mockListTimeEntries = vi.fn();
export const mockGetCurrentTimeEntry = vi.fn();
export const mockCreateTimeEntry = vi.fn();
export const mockUpdateTimeEntry = vi.fn();
export const mockStopTimeEntry = vi.fn();
export const mockDeleteTimeEntry = vi.fn();
export const mockListProjects = vi.fn();
export const mockGetProject = vi.fn();
export const mockCreateProject = vi.fn();
export const mockUpdateProject = vi.fn();
export const mockListClients = vi.fn();
export const mockCreateClient = vi.fn();
export const mockUpdateClient = vi.fn();
export const mockListTags = vi.fn();
export const mockCreateTag = vi.fn();
export const mockListTasks = vi.fn();
export const mockGetTask = vi.fn();
export const mockDeleteProject = vi.fn();
export const mockListWorkspaceUsers = vi.fn();
export const mockListProjectUsers = vi.fn();
export const mockAddProjectUser = vi.fn();
export const mockGetClient = vi.fn();
export const mockDeleteClient = vi.fn();
export const mockArchiveClient = vi.fn();
export const mockRestoreClient = vi.fn();
export const mockUpdateTag = vi.fn();
export const mockDeleteTag = vi.fn();
export const mockCreateTask = vi.fn();
export const mockUpdateTask = vi.fn();
export const mockDeleteTask = vi.fn();
export const mockReportSummary = vi.fn();
export const mockReportDetailed = vi.fn();
export const mockReportWeekly = vi.fn();
export const mockReportProjectSummary = vi.fn();

export function createTogglClientMock(original: typeof import('../src/client.js')) {
  return {
    ...original,
    TogglClient: class MockTogglClient {
      validateApiKey = mockValidateApiKey;
      me = mockMe;
      listWorkspaces = mockListWorkspaces;
      getWorkspace = mockGetWorkspace;
      listTimeEntries = mockListTimeEntries;
      getCurrentTimeEntry = mockGetCurrentTimeEntry;
      createTimeEntry = mockCreateTimeEntry;
      updateTimeEntry = mockUpdateTimeEntry;
      stopTimeEntry = mockStopTimeEntry;
      deleteTimeEntry = mockDeleteTimeEntry;
      listProjects = mockListProjects;
      getProject = mockGetProject;
      createProject = mockCreateProject;
      updateProject = mockUpdateProject;
      listClients = mockListClients;
      createClient = mockCreateClient;
      updateClient = mockUpdateClient;
      listTags = mockListTags;
      createTag = mockCreateTag;
      listTasks = mockListTasks;
      getTask = mockGetTask;
      deleteProject = mockDeleteProject;
      listWorkspaceUsers = mockListWorkspaceUsers;
      listProjectUsers = mockListProjectUsers;
      addProjectUser = mockAddProjectUser;
      getClient = mockGetClient;
      deleteClient = mockDeleteClient;
      archiveClient = mockArchiveClient;
      restoreClient = mockRestoreClient;
      updateTag = mockUpdateTag;
      deleteTag = mockDeleteTag;
      createTask = mockCreateTask;
      updateTask = mockUpdateTask;
      deleteTask = mockDeleteTask;
      reportSummary = mockReportSummary;
      reportDetailed = mockReportDetailed;
      reportWeekly = mockReportWeekly;
      reportProjectSummary = mockReportProjectSummary;
    },
  };
}

export const apiKeyConfig: ApiKeyConfig = {
  apiKey: 'test-toggl-token',
  headerName: 'Authorization',
  headerValue: 'Basic dGVzdC10b2dnbC10b2tlbjphcGlfdG9rZW4=',
};
