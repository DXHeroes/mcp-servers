/**
 * Shared setup for the MerkMcpServer unit suites.
 *
 * Deliberately not named `*.test.ts` so Vitest does not collect it as a suite.
 * Every `server.*.test.ts` file imports the same MerkClient doubles, the same
 * fixture and the same lifecycle bodies from here, so the setup cannot drift
 * between them.
 *
 * `vi.mock()` is hoisted per module and so cannot be shared through an import:
 * each suite repeats the `vi.mock('../src/client.js', ...)` call itself. The
 * factory may only reach this module from *inside* the double's constructor —
 * a suite that also imports `../src/server.js` for a value pulls the mocked
 * client in before this module has finished evaluating, and anything the
 * factory body touches eagerly would still be in its temporal dead zone.
 */

import type { ApiKeyConfig } from '@dxheroes/mcp-kit';
import { vi } from 'vitest';
import type { MerkMcpServer } from '../src/server.js';

// Mock the MerkClient
export const mockValidateApiKey = vi.fn();
export const mockCompanyLookup = vi.fn();
export const mockCompanyBatch = vi.fn();
export const mockSuggest = vi.fn();
export const mockSearchCompanies = vi.fn();
export const mockFinancialStatements = vi.fn();
export const mockFinancialIndicators = vi.fn();
export const mockCompanyEmployees = vi.fn();
export const mockCompanyFleet = vi.fn();
export const mockCompanyFleetStats = vi.fn();
export const mockCompanyBusinessPremises = vi.fn();
export const mockCompanyLicenses = vi.fn();
export const mockCompanyEvents = vi.fn();
export const mockNewCompanies = vi.fn();
export const mockUpdatedCompanies = vi.fn();
export const mockCompanyJobAds = vi.fn();
export const mockCompanyGovContracts = vi.fn();
export const mockRelationsCompany = vi.fn();
export const mockRelationsPerson = vi.fn();
export const mockRelationsSearchPerson = vi.fn();
export const mockRelationsShortestPath = vi.fn();
export const mockEnums = vi.fn();
export const mockSubscriptionInfo = vi.fn();
export const mockVokativ = vi.fn();

/**
 * The double's method table. Each suite's `vi.mock` factory copies it onto the
 * stand-in `MerkClient` instance, which is why the copy happens in a
 * constructor rather than in the factory body.
 */
export const merkClientMocks = {
  validateApiKey: mockValidateApiKey,
  companyLookup: mockCompanyLookup,
  companyBatch: mockCompanyBatch,
  suggest: mockSuggest,
  searchCompanies: mockSearchCompanies,
  financialStatements: mockFinancialStatements,
  financialIndicators: mockFinancialIndicators,
  companyEmployees: mockCompanyEmployees,
  companyFleet: mockCompanyFleet,
  companyFleetStats: mockCompanyFleetStats,
  companyBusinessPremises: mockCompanyBusinessPremises,
  companyLicenses: mockCompanyLicenses,
  companyEvents: mockCompanyEvents,
  newCompanies: mockNewCompanies,
  updatedCompanies: mockUpdatedCompanies,
  companyJobAds: mockCompanyJobAds,
  companyGovContracts: mockCompanyGovContracts,
  relationsCompany: mockRelationsCompany,
  relationsPerson: mockRelationsPerson,
  relationsSearchPerson: mockRelationsSearchPerson,
  relationsShortestPath: mockRelationsShortestPath,
  enums: mockEnums,
  subscriptionInfo: mockSubscriptionInfo,
  vokativ: mockVokativ,
};

/** The API key config the server under test is constructed with. */
export const apiKeyConfig: ApiKeyConfig = {
  apiKey: 'test-merk-key',
  headerName: 'Authorization',
  headerValue: 'Token test-merk-key',
};

/** The shared outer `beforeEach` body: drop calls recorded by a previous test. */
export function resetMerkClientMocks(): void {
  vi.clearAllMocks();
}

/**
 * The shared inner `beforeEach` body: a server that has finished initializing.
 *
 * The `MerkMcpServer` import is deferred to call time on purpose — a static one
 * would pull `../src/client.js` in while this module is still evaluating, and
 * the hoisted `vi.mock` factory would then read the doubles above before they
 * exist.
 */
export async function createInitializedServer(): Promise<MerkMcpServer> {
  const { MerkMcpServer: Server } = await import('../src/server.js');
  const server = new Server(apiKeyConfig);
  await server.initialize();
  return server;
}
