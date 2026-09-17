/**
 * Merk MCP Server
 *
 * Wraps the Merk API (https://api.merk.cz/docs/) — Czech/Slovak company data platform.
 * Provides 23 tools covering company details, financials, employees, fleet, relations, and more.
 */

import type { ApiKeyConfig, McpResource, McpTool, ToolAnnotations } from '@dxheroes/mcp-kit';
import { McpServer } from '@dxheroes/mcp-kit';
import { z } from 'zod';
import { MerkApiError, MerkClient } from './client.js';
import {
  CompanyBatchSchema,
  CompanyEventsSchema,
  CompanyLookupSchema,
  DateRangeSchema,
  EnumsSchema,
  RegnoSchema,
  RegnoWithPaginationSchema,
  RelationsCompanySchema,
  RelationsPersonSchema,
  RelationsSearchPersonSchema,
  RelationsShortestPathSchema,
  SearchCompaniesSchema,
  SubscriptionInfoSchema,
  SuggestSchema,
  VokativSchema,
} from './schemas.js';

/**
 * Every tool in this package reads; none of them writes.
 *
 * That is not a claim about the API being small — it is what the client can
 * physically do. `MerkClient.request()` accepts `'GET' | 'POST'` and nothing
 * else, and each of the two POSTs it makes is a query whose input is too large
 * for a query string: `/company/mget/` (up to 500 registration numbers) and
 * `/search/{country}/` (a filter document). A POST used as transport for a big
 * question is still a question.
 *
 * The annotation matters because the connector host classifies on `readOnlyHint`
 * alone, and an unannotated tool is assumed to be a write. Without these, all
 * 23 tools land in the write group together and an operator gets one switch
 * for the package — allow every Merk query, or none. Per the MCP spec these
 * are hints, not a security boundary; the package restricts nothing itself.
 *
 * `idempotentHint` is true because Merk is a register: repeating a query
 * changes nothing on Merk's side and returns the same answer until the
 * register itself changes. `openWorldHint` is true because the answers come
 * from an external service.
 *
 * One honest caveat: a call is not free. Merk meters requests against a
 * subscription — `merk_subscription_info` is the tool that reports the plan
 * and what is left of it — so repeating a query costs credits. That is a cost
 * of asking, not a modification of the data the tool addresses, which is what
 * `readOnlyHint` is about; a rate-limited read is still a read.
 *
 * There is deliberately no `WRITE_TOOL` or `DESTRUCTIVE_TOOL` constant here.
 * Nothing would reference them, and an unused annotation constant is an
 * invitation to reach for whichever one looks closest. Anyone adding a write
 * tool should write the annotation that tool actually needs, judging
 * "destructive" by the MCP definition — not purely additive — rather than by
 * whether the name contains `delete`. `connectors/toggl/src/server.ts` has
 * the worked example.
 */
const READ_ONLY_TOOL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  annotations: ToolAnnotations;
  handler: (args: unknown) => Promise<unknown>;
}

export class MerkMcpServer extends McpServer {
  private client: MerkClient | null = null;
  private initError: string | null = null;
  private toolDefs: ToolDef[] = [];

  constructor(private apiKeyConfig: ApiKeyConfig | null) {
    super();
  }

  async initialize(): Promise<void> {
    if (!this.apiKeyConfig?.apiKey) {
      this.initError =
        'Merk API key is not configured. Please configure the API key in the MCP server settings.';
      console.warn('[Merk] No API key configured');
      return;
    }

    try {
      this.client = new MerkClient(this.apiKeyConfig.apiKey);
      this.initError = null;
      this.toolDefs = this.buildToolDefs();
    } catch (error) {
      this.initError = `Failed to initialize Merk client: ${error instanceof Error ? error.message : 'Unknown error'}`;
      console.error('[Merk] Initialization error:', error);
    }
  }

  override async validate(): Promise<{ valid: boolean; error?: string }> {
    if (!this.apiKeyConfig?.apiKey) {
      return { valid: false, error: 'API key not configured' };
    }

    try {
      const client = new MerkClient(this.apiKeyConfig.apiKey);
      return await client.validateApiKey();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { valid: false, error: `Validation failed: ${msg}` };
    }
  }

  async listTools(): Promise<McpTool[]> {
    if (this.toolDefs.length === 0) {
      this.toolDefs = this.buildToolDefs();
    }
    return this.toolDefs.map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations,
    }));
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    if (!this.client) {
      return this.errorResponse(
        'API_KEY_REQUIRED',
        this.initError ||
          'Merk API key is not configured. Please configure the API key in the MCP server settings.',
      );
    }

    const toolDef = this.toolDefs.find((t) => t.name === name);
    if (!toolDef) {
      return this.errorResponse(
        'UNKNOWN_TOOL',
        `Unknown tool: ${name}. Use listTools() to see available tools.`,
      );
    }

    // Validate input
    let parsed: unknown;
    try {
      parsed = toolDef.inputSchema.parse(args);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'INVALID_INPUT',
                message: 'Invalid input parameters',
                details: error.issues.map((issue) => ({
                  path: issue.path.join('.'),
                  message: issue.message,
                })),
              }),
            },
          ],
          isError: true,
        };
      }
      throw error;
    }

    // Execute
    try {
      const result = await toolDef.handler(parsed);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(this.successPayload(name, result)),
          },
        ],
      };
    } catch (error) {
      return this.handleApiError(error);
    }
  }

  async listResources(): Promise<McpResource[]> {
    return [];
  }

  async readResource(_uri: string): Promise<unknown> {
    throw new Error('No resources available in Merk MCP');
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * `MerkClient` returns `undefined` when Merk answered with a success status
   * and no body at all — a 204/205, or the empty 200 that used to reach
   * `response.json()` and come back as a SyntaxError. `JSON.stringify(
   * undefined)` *is* `undefined`, so handing that straight to the content
   * block would drop the `text` key and leave the model with
   * `{"content":[{"type":"text"}]}`: nothing to read, and nothing to tell
   * apart from a failure.
   *
   * What an empty body means depends on the tool, which is why this reads the
   * annotation instead of guessing. Every tool here is currently read-only, so
   * in practice only the first branch fires. For a query, an empty body is not
   * an answer, and it is emphatically not "no records" — Merk reports those as
   * an empty list. Calling it a success would invite the model to report that
   * a company has no employees, no fleet and no licences on the strength of a
   * blank response. The write branch is what a future write tool would need,
   * and it is kept so that adding one cannot silently inherit the read wording.
   *
   * A real `null` is left alone: it is valid JSON and a genuine answer, and
   * the client keeps "no body" distinct from it for exactly this reason.
   */
  private successPayload(tool: string, result: unknown): unknown {
    if (result !== undefined) return result;
    const isRead = this.toolDefs.find((t) => t.name === tool)?.annotations.readOnlyHint === true;
    if (isRead) {
      return {
        success: false,
        tool,
        message:
          'Merk answered with a success status but no response body. For a query that is not an answer: it does NOT mean the register holds no matching records — Merk reports those as an empty list or an empty result set. Treat the data as unknown, retry once, and do not report "nothing found" on the strength of this response.',
      };
    }
    return {
      success: true,
      tool,
      message:
        'Merk acknowledged this write with an empty response body — the change was applied. There is nothing to read back; query the record again if its new state is needed.',
    };
  }

  private errorResponse(error: string, message: string, hint?: string) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(hint ? { error, message, hint } : { error, message }),
        },
      ],
      isError: true,
    };
  }

  private handleApiError(error: unknown) {
    if (error instanceof MerkApiError) {
      // `error.message` is the bare upstream text — the code travels in its
      // own field, so it must not be prefixed onto the message as well.
      return this.errorResponse(error.code, error.message, error.hint);
    }
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return this.errorResponse('API_ERROR', msg);
  }

  private buildToolDefs(): ToolDef[] {
    if (!this.client) return [];
    const c = this.client;
    return [
      {
        name: 'merk_company_lookup',
        description:
          'Look up a Czech or Slovak company by registration number (IČO) or VAT number (DIČ). Returns detailed company information.',
        inputSchema: CompanyLookupSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.companyLookup(args as z.infer<typeof CompanyLookupSchema>),
      },
      {
        name: 'merk_company_batch',
        description:
          'Batch lookup of up to 500 companies by registration numbers. More efficient than individual lookups.',
        inputSchema: CompanyBatchSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.companyBatch(args as z.infer<typeof CompanyBatchSchema>),
      },
      {
        name: 'merk_company_suggest',
        description:
          'Suggest/autocomplete companies by name, email, or bank account number. Fast fuzzy search.',
        inputSchema: SuggestSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.suggest(args as z.infer<typeof SuggestSchema>),
      },
      {
        name: 'merk_search_companies',
        description:
          'Advanced search for Czech (cz) or Slovak (sk) companies with filters. Returns paginated results.',
        inputSchema: SearchCompaniesSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.searchCompanies(args as z.infer<typeof SearchCompaniesSchema>),
      },
      {
        name: 'merk_financial_statements',
        description:
          'Get financial statements (balance sheet, P&L) for a company by registration number.',
        inputSchema: RegnoSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.financialStatements(args as z.infer<typeof RegnoSchema>),
      },
      {
        name: 'merk_financial_indicators',
        description:
          'Get computed financial indicators (ROE, debt ratio, liquidity, etc.) for a company.',
        inputSchema: RegnoSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.financialIndicators(args as z.infer<typeof RegnoSchema>),
      },
      {
        name: 'merk_company_employees',
        description: 'Get employee count and structure for a company. Supports pagination.',
        inputSchema: RegnoWithPaginationSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.companyEmployees(args as z.infer<typeof RegnoWithPaginationSchema>),
      },
      {
        name: 'merk_company_fleet',
        description: 'Get vehicle fleet registered to a company.',
        inputSchema: RegnoSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.companyFleet(args as z.infer<typeof RegnoSchema>),
      },
      {
        name: 'merk_company_fleet_stats',
        description: 'Get fleet statistics (vehicle count by type, age, etc.) for a company.',
        inputSchema: RegnoSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.companyFleetStats(args as z.infer<typeof RegnoSchema>),
      },
      {
        name: 'merk_company_business_premises',
        description: 'Get registered business premises (provozovny) for a company.',
        inputSchema: RegnoSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.companyBusinessPremises(args as z.infer<typeof RegnoSchema>),
      },
      {
        name: 'merk_company_licenses',
        description: 'Get trade licenses (živnostenská oprávnění) for a company.',
        inputSchema: RegnoSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.companyLicenses(args as z.infer<typeof RegnoSchema>),
      },
      {
        name: 'merk_company_events',
        description:
          'Get company events (changes in registry, insolvency filings, etc.). Optionally filter by date range.',
        inputSchema: CompanyEventsSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.companyEvents(args as z.infer<typeof CompanyEventsSchema>),
      },
      {
        name: 'merk_new_companies',
        description:
          'Get newly registered companies in a date range. Supports filtering by country.',
        inputSchema: DateRangeSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.newCompanies(args as z.infer<typeof DateRangeSchema>),
      },
      {
        name: 'merk_updated_companies',
        description:
          'Get companies that were updated (changed data) in a date range. Supports filtering by country.',
        inputSchema: DateRangeSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.updatedCompanies(args as z.infer<typeof DateRangeSchema>),
      },
      {
        name: 'merk_company_job_ads',
        description: 'Get current and historical job advertisements posted by a company.',
        inputSchema: RegnoSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.companyJobAds(args as z.infer<typeof RegnoSchema>),
      },
      {
        name: 'merk_company_gov_contracts',
        description: 'Get government contracts (veřejné zakázky) associated with a company.',
        inputSchema: RegnoSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.companyGovContracts(args as z.infer<typeof RegnoSchema>),
      },
      {
        name: 'merk_relations_company',
        description:
          'Get relations graph for a company — owners, board members, subsidiaries, etc.',
        inputSchema: RelationsCompanySchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.relationsCompany(args as z.infer<typeof RelationsCompanySchema>),
      },
      {
        name: 'merk_relations_person',
        description:
          'Get relations graph for a person — companies they own, boards they sit on, etc.',
        inputSchema: RelationsPersonSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.relationsPerson(args as z.infer<typeof RelationsPersonSchema>),
      },
      {
        name: 'merk_relations_search_person',
        description: 'Search for a person in the relations graph by name and optional birth date.',
        inputSchema: RelationsSearchPersonSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) =>
          c.relationsSearchPerson(args as z.infer<typeof RelationsSearchPersonSchema>),
      },
      {
        name: 'merk_relations_shortest_path',
        description:
          'Find the shortest path between two nodes (companies/persons) in the relations graph.',
        inputSchema: RelationsShortestPathSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) =>
          c.relationsShortestPath(args as z.infer<typeof RelationsShortestPathSchema>),
      },
      {
        name: 'merk_enums',
        description:
          'Get enum/code list values used in the API (legal forms, NACE codes, etc.). Optionally specify an enum ID.',
        inputSchema: EnumsSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.enums(args as z.infer<typeof EnumsSchema>),
      },
      {
        name: 'merk_subscription_info',
        description: 'Get your Merk API subscription info — plan, remaining credits, rate limits.',
        inputSchema: SubscriptionInfoSchema,
        annotations: READ_ONLY_TOOL,
        handler: () => c.subscriptionInfo(),
      },
      {
        name: 'merk_vokativ',
        description:
          'Get the Czech vocative (5th grammatical case) form of a name. Useful for personalized Czech communications.',
        inputSchema: VokativSchema,
        annotations: READ_ONLY_TOOL,
        handler: (args) => c.vokativ(args as z.infer<typeof VokativSchema>),
      },
    ];
  }
}
