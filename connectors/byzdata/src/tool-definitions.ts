/**
 * ByzData tool and resource definitions.
 *
 * The input schemas live here too, because they are half of a tool's
 * definition — `callTool` parses with the same object `listTools` advertises.
 */

import type { McpResource, McpTool, ToolAnnotations } from '@dxheroes/mcp-kit';
import { z } from 'zod';

/**
 * Every tool in this package is a lookup into a public Czech registry.
 *
 * The annotation is not decoration: the connector host derives a tool's risk tier
 * from it (`packages/kit/src/utils/tool-classification.ts`), and a tool with
 * no annotation at all falls into the `write` group. Unannotated, all nine
 * read-only lookups here would land there, and an operator wanting to allow
 * plain company lookups without allowing writes would have no lever to pull.
 *
 * `idempotentHint` is true because the same IČO returns the same record until
 * the registry itself changes, and `openWorldHint` is true because every one
 * of these calls leaves the connector host for ares.gov.cz, or.justice.cz or eISIR.
 *
 * There is no `WRITE_TOOL` or `DESTRUCTIVE_TOOL` counterpart in this file, and
 * that is not an omission: ARES, the commercial register and the insolvency
 * register expose no write surface to this package. Nothing here can change a
 * record anywhere, so nothing here can be destructive. A future tool that
 * writes must add its own constant rather than reuse this one.
 */
const READ_ONLY_TOOL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const IcoSchema = z
  .string()
  .regex(/^\d{1,8}$/, 'IČO must be 1-8 digits')
  .describe('Company IČO (identification number)');

export const SearchInputSchema = z.object({
  query: z.string().describe('Company name or partial name to search'),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(10)
    .describe('Max results to return (1-100, default 10)'),
});

export const IcoInputSchema = z.object({
  ico: IcoSchema,
});

export function buildToolDefinitions(): McpTool[] {
  return [
    {
      name: 'search_company',
      description:
        'Search Czech companies by name. Returns a list of matching companies with basic info.',
      inputSchema: SearchInputSchema,
      annotations: READ_ONLY_TOOL,
    },
    {
      name: 'get_company',
      description:
        'Get full company overview by IČO (Czech company registration number). ' +
        'Returns name, address, legal form, establishment date, VAT number, court file, ' +
        'NACE codes, share capital.',
      inputSchema: IcoInputSchema,
      annotations: READ_ONLY_TOOL,
    },
    {
      name: 'get_company_details',
      description:
        'Get company business activities, trade licenses, and NACE industry codes by IČO.',
      inputSchema: IcoInputSchema,
      annotations: READ_ONLY_TOOL,
    },
    {
      name: 'get_company_relations',
      description:
        'Get company statutory bodies (directors, board members), shareholders, ' +
        'and their roles by IČO.',
      inputSchema: IcoInputSchema,
      annotations: READ_ONLY_TOOL,
    },
    {
      name: 'get_company_documents',
      description:
        'Get list of company documents from the Czech commercial register collection ' +
        '(sbírka listin). Includes financial statements, founding documents, notarial records.',
      inputSchema: IcoInputSchema,
      annotations: READ_ONLY_TOOL,
    },
    {
      name: 'get_company_extract',
      description:
        'Get full company extract from the Czech commercial register (obchodní rejstřík). ' +
        'Includes detailed info about statutory bodies, shareholders with shares, business ' +
        'activities, representation method, and other facts as registered at the court.',
      inputSchema: IcoInputSchema,
      annotations: READ_ONLY_TOOL,
    },
    {
      name: 'check_insolvency',
      description:
        'Check if a Czech company is or was in insolvency proceedings. ' +
        'Queries the Czech insolvency register (ISIR/eISIR).',
      inputSchema: IcoInputSchema,
      annotations: READ_ONLY_TOOL,
    },
    {
      name: 'check_company_health',
      description:
        'Comprehensive health check of a Czech company. Checks registration status, ' +
        'VAT status, insolvency, trade licenses, and company age. Returns a traffic-light ' +
        'assessment.',
      inputSchema: IcoInputSchema,
      annotations: READ_ONLY_TOOL,
    },
    {
      name: 'find_related_companies',
      description:
        'Find companies related to a given company through shared people (directors, ' +
        'shareholders). Discovers the ownership/management network by finding all statutory ' +
        'body members and their other companies.',
      inputSchema: IcoInputSchema,
      annotations: READ_ONLY_TOOL,
    },
  ];
}

export function buildResourceDefinitions(): McpResource[] {
  return [
    {
      uri: 'company://{ico}/overview',
      name: 'company-overview',
      description: 'Company overview — basic info, address, legal form, share capital',
    },
    {
      uri: 'company://{ico}/relations',
      name: 'company-relations',
      description: 'Company relations — statutory bodies, shareholders',
    },
    {
      uri: 'company://{ico}/documents',
      name: 'company-documents',
      description: 'Company documents — sbírka listin',
    },
  ];
}
