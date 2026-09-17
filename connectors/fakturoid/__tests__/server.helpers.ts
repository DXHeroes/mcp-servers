/**
 * Shared fixtures for the FakturoidMcpServer unit suites.
 *
 * Split out of the original server.test.ts so that every `server.*.test.ts`
 * file stubs the client and builds its server exactly the same way.
 *
 * The `vi.mock('../src/client.js', ...)` call that these suites also share
 * cannot live here: module mocks are hoisted per test file, so each suite
 * repeats the call verbatim and delegates its factory body to
 * `mockClientModule` below.
 */

import type { ApiKeyConfig } from '@dxheroes/mcp-kit';
import { vi } from 'vitest';
import type { FakturoidMcpServer } from '../src/server.js';

type ClientModule = typeof import('../src/client.js');

// Mock all client methods
export const mockValidateApiKey = vi.fn();
export const mockGetAccount = vi.fn();
export const mockListUsers = vi.fn();
export const mockListBankAccounts = vi.fn();
export const mockListInvoices = vi.fn();
export const mockGetInvoice = vi.fn();
export const mockCreateInvoice = vi.fn();
export const mockUpdateInvoice = vi.fn();
export const mockInvoiceAction = vi.fn();
export const mockSearchInvoices = vi.fn();
export const mockDeleteInvoice = vi.fn();
export const mockCreatePayment = vi.fn();
export const mockDeletePayment = vi.fn();
export const mockSendInvoiceMessage = vi.fn();
export const mockListSubjects = vi.fn();
export const mockGetSubject = vi.fn();
export const mockCreateSubject = vi.fn();
export const mockSearchSubjects = vi.fn();
export const mockUpdateSubject = vi.fn();
export const mockDeleteSubject = vi.fn();
export const mockListExpenses = vi.fn();
export const mockCreateExpense = vi.fn();
export const mockGetExpense = vi.fn();
export const mockUpdateExpense = vi.fn();
export const mockSearchExpenses = vi.fn();
export const mockDeleteExpense = vi.fn();
export const mockExpenseAction = vi.fn();
export const mockCreateExpensePayment = vi.fn();
export const mockDeleteExpensePayment = vi.fn();
export const mockListInventoryItems = vi.fn();
export const mockGetInventoryItem = vi.fn();
export const mockCreateInventoryItem = vi.fn();
export const mockUpdateInventoryItem = vi.fn();
export const mockSearchInventoryItems = vi.fn();
export const mockListInventoryMoves = vi.fn();
export const mockCreateInventoryMove = vi.fn();
export const mockListGenerators = vi.fn();
export const mockGetGenerator = vi.fn();
export const mockCreateGenerator = vi.fn();
export const mockListRecurringGenerators = vi.fn();
export const mockGetRecurringGenerator = vi.fn();
export const mockListEvents = vi.fn();
export const mockListTodos = vi.fn();
export const mockToggleTodo = vi.fn();
export const mockListTags = vi.fn();
export const mockListNumberFormats = vi.fn();

/**
 * The body of the shared `vi.mock('../src/client.js', ...)` factory: the real
 * module with `FakturoidClient` swapped for a class whose every method is one
 * of the spies above.
 */
export function mockClientModule(original: ClientModule): ClientModule {
  return {
    ...original,
    FakturoidClient: class MockFakturoidClient {
      validateApiKey = mockValidateApiKey;
      getAccount = mockGetAccount;
      listUsers = mockListUsers;
      listBankAccounts = mockListBankAccounts;
      listInvoices = mockListInvoices;
      getInvoice = mockGetInvoice;
      createInvoice = mockCreateInvoice;
      updateInvoice = mockUpdateInvoice;
      invoiceAction = mockInvoiceAction;
      searchInvoices = mockSearchInvoices;
      deleteInvoice = mockDeleteInvoice;
      createPayment = mockCreatePayment;
      deletePayment = mockDeletePayment;
      sendInvoiceMessage = mockSendInvoiceMessage;
      listSubjects = mockListSubjects;
      getSubject = mockGetSubject;
      createSubject = mockCreateSubject;
      searchSubjects = mockSearchSubjects;
      updateSubject = mockUpdateSubject;
      deleteSubject = mockDeleteSubject;
      listExpenses = mockListExpenses;
      createExpense = mockCreateExpense;
      getExpense = mockGetExpense;
      updateExpense = mockUpdateExpense;
      searchExpenses = mockSearchExpenses;
      deleteExpense = mockDeleteExpense;
      expenseAction = mockExpenseAction;
      createExpensePayment = mockCreateExpensePayment;
      deleteExpensePayment = mockDeleteExpensePayment;
      listInventoryItems = mockListInventoryItems;
      getInventoryItem = mockGetInventoryItem;
      createInventoryItem = mockCreateInventoryItem;
      updateInventoryItem = mockUpdateInventoryItem;
      searchInventoryItems = mockSearchInventoryItems;
      listInventoryMoves = mockListInventoryMoves;
      createInventoryMove = mockCreateInventoryMove;
      listGenerators = mockListGenerators;
      getGenerator = mockGetGenerator;
      createGenerator = mockCreateGenerator;
      listRecurringGenerators = mockListRecurringGenerators;
      getRecurringGenerator = mockGetRecurringGenerator;
      listEvents = mockListEvents;
      listTodos = mockListTodos;
      toggleTodo = mockToggleTodo;
      listTags = mockListTags;
      listNumberFormats = mockListNumberFormats;
    },
  } as unknown as ClientModule;
}

export const apiKeyConfig: ApiKeyConfig = {
  apiKey: 'test-slug:test-client-id:test-client-secret',
  headerName: 'Authorization',
  headerValue: 'Bearer test-token',
};

/** The shared top-level `beforeEach` body. */
export function resetMocks(): void {
  vi.clearAllMocks();
}

/**
 * The shared `beforeEach` body of every suite that reuses one initialized
 * server. The import is dynamic so that this module stays free of a static
 * dependency on `../src/server.js`, which would otherwise be pulled in while
 * the mocked `../src/client.js` factory is still running.
 */
export async function createInitializedServer(): Promise<FakturoidMcpServer> {
  const { FakturoidMcpServer: Server } = await import('../src/server.js');
  const server = new Server(apiKeyConfig);
  await server.initialize();
  return server;
}
