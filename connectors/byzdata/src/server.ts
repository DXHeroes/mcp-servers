/**
 * ByzData MCP Server
 *
 * Czech business registry data from ARES, Justice.cz, and ISIR.
 *
 * This file is the wiring: it fetches, decides absent-vs-unavailable, and
 * wraps the result in an MCP response. The markdown bodies live in
 * `markdown-renderers.ts`, the derived verdicts in `health-assessment.ts`,
 * and the tool/resource declarations in `tool-definitions.ts`.
 */

import type { McpResource, McpTool } from '@dxheroes/mcp-kit';
import { McpServer } from '@dxheroes/mcp-kit';
import { z } from 'zod';
import { IsirClient } from './clients/isir-client.js';
import { JusticeScraper } from './clients/justice-scraper.js';
import {
  collectRelatedPeople,
  renderHealthCheck,
  renderRelatedCompanies,
} from './health-assessment.js';
import {
  renderCompanyDetails,
  renderCompanyExtract,
  renderCompanyOverview,
  renderCompanyRelations,
  renderDocumentList,
  renderDocumentsResource,
  renderInsolvencyCases,
  renderOverviewResource,
  renderRelationsResource,
  renderSearchResults,
} from './markdown-renderers.js';
import { CompanyService } from './services/company-service.js';
import {
  buildResourceDefinitions,
  buildToolDefinitions,
  IcoInputSchema,
  SearchInputSchema,
} from './tool-definitions.js';
import { ByzdataError } from './utils/http.js';

export class ByzdataMcpServer extends McpServer {
  private service!: CompanyService;
  private scraper!: JusticeScraper;
  private isir!: IsirClient;

  async initialize(): Promise<void> {
    this.service = new CompanyService();
    this.scraper = new JusticeScraper();
    this.isir = new IsirClient();
  }

  async listTools(): Promise<McpTool[]> {
    return buildToolDefinitions();
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    try {
      switch (name) {
        case 'search_company':
          return await this.handleSearchCompany(args);
        case 'get_company':
          return await this.handleGetCompany(args);
        case 'get_company_details':
          return await this.handleGetCompanyDetails(args);
        case 'get_company_relations':
          return await this.handleGetCompanyRelations(args);
        case 'get_company_documents':
          return await this.handleGetCompanyDocuments(args);
        case 'get_company_extract':
          return await this.handleGetCompanyExtract(args);
        case 'check_insolvency':
          return await this.handleCheckInsolvency(args);
        case 'check_company_health':
          return await this.handleCheckCompanyHealth(args);
        case 'find_related_companies':
          return await this.handleFindRelatedCompanies(args);
        default:
          return this.errorResponse('UNKNOWN_TOOL', `Unknown tool: ${name}`);
      }
    } catch (error) {
      return this.handleToolError(error);
    }
  }

  async listResources(): Promise<McpResource[]> {
    return buildResourceDefinitions();
  }

  async readResource(uri: string): Promise<unknown> {
    const overviewMatch = uri.match(/^company:\/\/(\d+)\/overview$/);
    if (overviewMatch?.[1]) {
      const ico = overviewMatch[1];
      const overview = await this.service.getOverview(ico);
      if (!overview) {
        return { contents: [{ uri, text: `Company ${ico} not found.`, mimeType: 'text/plain' }] };
      }
      const text = renderOverviewResource(overview);
      return { contents: [{ uri, text, mimeType: 'text/markdown' }] };
    }

    const relationsMatch = uri.match(/^company:\/\/(\d+)\/relations$/);
    if (relationsMatch?.[1]) {
      const ico = relationsMatch[1];
      const relations = await this.service.getRelations(ico);
      if (!relations) {
        return { contents: [{ uri, text: `Company ${ico} not found.`, mimeType: 'text/plain' }] };
      }
      return {
        contents: [{ uri, text: renderRelationsResource(relations), mimeType: 'text/markdown' }],
      };
    }

    const documentsMatch = uri.match(/^company:\/\/(\d+)\/documents$/);
    if (documentsMatch?.[1]) {
      const ico = documentsMatch[1];
      const docs = await this.scraper.getDocumentList(ico);
      if (!docs) {
        return { contents: [{ uri, text: `Company ${ico} not found.`, mimeType: 'text/plain' }] };
      }
      return {
        contents: [{ uri, text: renderDocumentsResource(ico, docs), mimeType: 'text/markdown' }],
      };
    }

    throw new Error(`Unknown resource URI: ${uri}`);
  }

  // ── Tool Handlers ──────────────────────────────────────────

  private async handleSearchCompany(args: unknown): Promise<unknown> {
    const input = SearchInputSchema.parse(args);
    const results = await this.service.search(input.query, input.limit);

    if (results.length === 0) {
      return this.textResponse(`No companies found matching "${input.query}".`);
    }

    return this.textResponse(renderSearchResults(input.query, results));
  }

  private async handleGetCompany(args: unknown): Promise<unknown> {
    const { ico } = IcoInputSchema.parse(args);
    const company = await this.service.getOverview(ico);

    if (!company) {
      return this.errorResponse('NOT_FOUND', `Company with IČO ${ico} not found.`);
    }

    return this.textResponse(renderCompanyOverview(company));
  }

  private async handleGetCompanyDetails(args: unknown): Promise<unknown> {
    const { ico } = IcoInputSchema.parse(args);
    const details = await this.service.getDetails(ico);

    if (!details) {
      return this.errorResponse('NOT_FOUND', `Company with IČO ${ico} not found.`);
    }

    return this.textResponse(renderCompanyDetails(details));
  }

  private async handleGetCompanyRelations(args: unknown): Promise<unknown> {
    const { ico } = IcoInputSchema.parse(args);
    const relations = await this.service.getRelations(ico);

    if (!relations) {
      return this.errorResponse('NOT_FOUND', `Company with IČO ${ico} not found.`);
    }

    return this.textResponse(renderCompanyRelations(relations));
  }

  private async handleGetCompanyDocuments(args: unknown): Promise<unknown> {
    const { ico } = IcoInputSchema.parse(args);
    const documents = await this.scraper.getDocumentList(ico);

    if (!documents) {
      return this.errorResponse(
        'NOT_FOUND',
        `Company with IČO ${ico} not found in the commercial register.`,
      );
    }

    if (documents.length === 0) {
      return this.textResponse(`No documents found for IČO ${ico} in the collection.`);
    }

    return this.textResponse(renderDocumentList(ico, documents));
  }

  private async handleGetCompanyExtract(args: unknown): Promise<unknown> {
    const { ico } = IcoInputSchema.parse(args);
    const extract = await this.scraper.getCompanyExtract(ico);

    if (!extract) {
      return this.errorResponse(
        'NOT_FOUND',
        `Company with IČO ${ico} not found in the commercial register.`,
      );
    }

    return this.textResponse(renderCompanyExtract(ico, extract));
  }

  private async handleCheckInsolvency(args: unknown): Promise<unknown> {
    const { ico } = IcoInputSchema.parse(args);
    const cases = await this.isir.checkInsolvency(ico);

    if (cases.length === 0) {
      return this.textResponse(
        `**IČO ${ico} — Insolvence: NE**\n\n` +
          'Žádné insolvenční řízení nebylo nalezeno v registru ISIR.',
      );
    }

    return this.textResponse(renderInsolvencyCases(ico, cases));
  }

  private async handleCheckCompanyHealth(args: unknown): Promise<unknown> {
    const { ico } = IcoInputSchema.parse(args);

    // The insolvency leg is allowed to fail on its own. The other four checks
    // are still worth reporting when eISIR is down — what is not acceptable is
    // rendering an unreachable register as "Bez insolvence", which is what a
    // silent empty list used to produce.
    const [overview, details, insolvency] = await Promise.all([
      this.service.getOverview(ico),
      this.service.getDetails(ico),
      this.isir.checkInsolvency(ico).then(
        (cases) => ({ known: true as const, cases }),
        (error: unknown) => ({
          known: false as const,
          reason: error instanceof Error ? error.message : 'Unknown error',
        }),
      ),
    ]);

    if (!overview) {
      return this.errorResponse('NOT_FOUND', `Company with IČO ${ico} not found.`);
    }

    return this.textResponse(renderHealthCheck(overview, details, insolvency));
  }

  private async handleFindRelatedCompanies(args: unknown): Promise<unknown> {
    const { ico } = IcoInputSchema.parse(args);
    const relations = await this.service.getRelations(ico);

    if (!relations) {
      return this.errorResponse('NOT_FOUND', `Company with IČO ${ico} not found.`);
    }

    const people = collectRelatedPeople(relations);

    if (people.size === 0) {
      return this.textResponse(`No people found in statutory bodies of ${relations.name}.`);
    }

    const relatedMap = new Map<string, { companies: { name: string; ico: string }[] }>();
    // A failed person search is not "this person has no other companies". The
    // failures are counted so the summary can say the answer is partial —
    // silently skipping them meant a justice.cz outage rendered as a confident
    // "no connected companies".
    const failedSearches: string[] = [];

    for (const personName of people) {
      try {
        const results = await this.scraper.searchByPerson(personName);
        const otherCompanies = results.filter((r) => r.ico !== ico);
        if (otherCompanies.length > 0) {
          relatedMap.set(personName, {
            companies: otherCompanies.map((r) => ({ name: r.name, ico: r.ico })),
          });
        }
      } catch {
        failedSearches.push(personName);
      }
    }

    return this.textResponse(
      renderRelatedCompanies(relations, ico, people, relatedMap, failedSearches),
    );
  }

  // ── Helpers ────────────────────────────────────────────────

  private textResponse(text: string): unknown {
    return { content: [{ type: 'text', text }] };
  }

  private errorResponse(code: string, message: string, hint?: string): unknown {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(hint ? { error: code, message, hint } : { error: code, message }),
        },
      ],
      isError: true,
    };
  }

  /**
   * Turn anything thrown by a handler into a coded error response.
   *
   * Everything used to arrive as `TOOL_ERROR`, which made "eISIR is down",
   * "that IČO is not eight digits" and "the scraper hit a 500" the same answer
   * as far as the model was concerned — three problems with three different
   * remedies and one indistinguishable code.
   *
   * `error.message` is passed through unprefixed. The code is a separate JSON
   * field and prefixing it onto the text as well produced messages of the form
   * `RATE_LIMITED: "RATE_LIMITED: ..."`.
   */
  private handleToolError(error: unknown): unknown {
    if (error instanceof z.ZodError) {
      return this.errorResponse(
        'INVALID_INPUT',
        error.issues
          .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
          .join('; '),
        'Fix the arguments and call again. An IČO must be 1-8 digits with no spaces, dots or the "CZ" prefix.',
      );
    }

    if (error instanceof ByzdataError) {
      return this.errorResponse(error.code, error.message, error.hint);
    }

    return this.errorResponse(
      'TOOL_ERROR',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
