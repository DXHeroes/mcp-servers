/**
 * Derived assessments: the traffic-light health check and the
 * related-companies network.
 *
 * Unlike `markdown-renderers.ts`, these do not just format what a registry
 * returned — they turn several lookups into a verdict. The verdict rules and
 * the way an unresolved check is reported live here, together, because they
 * are the same decision: a result the caller cannot distinguish from a clean
 * one is worse than no result.
 */

import type { CompanyDetails, CompanyOverview, CompanyRelations } from './types/company.js';
import type { IsirCase } from './types/isir.js';

/**
 * The insolvency leg of a health check, which is allowed to fail on its own.
 */
export type InsolvencyProbe = { known: true; cases: IsirCase[] } | { known: false; reason: string };

export type RelatedCompaniesMap = Map<string, { companies: { name: string; ico: string }[] }>;

export function renderHealthCheck(
  overview: CompanyOverview,
  details: CompanyDetails | null,
  insolvency: InsolvencyProbe,
): string {
  const checks: { label: string; status: string; detail: string }[] = [];

  const vrStatus = overview.registrationStatus['Obchodní rejstřík'];
  checks.push({
    label: 'Obchodní rejstřík',
    status: vrStatus === 'AKTIVNI' ? '🟢' : '🔴',
    detail: vrStatus ?? 'N/A',
  });

  const dphStatus = overview.registrationStatus['DPH (VAT)'];
  checks.push({
    label: 'Plátce DPH',
    status: dphStatus === 'AKTIVNI' ? '🟢' : '🟡',
    detail: dphStatus ?? 'Neregistrován',
  });

  const insolvencyCases = insolvency.known ? insolvency.cases : [];
  const activeInsolvency = insolvencyCases.filter((c) => !c.datumUkonceni);
  checks.push({
    label: 'Insolvence',
    status: !insolvency.known
      ? '⚪'
      : activeInsolvency.length > 0
        ? '🔴'
        : insolvencyCases.length > 0
          ? '🟡'
          : '🟢',
    detail: !insolvency.known
      ? `NEZJIŠTĚNO — registr ISIR neodpověděl (${insolvency.reason})`
      : activeInsolvency.length > 0
        ? `AKTIVNÍ (${activeInsolvency.length} řízení)`
        : insolvencyCases.length > 0
          ? `Historická (${insolvencyCases.length} ukončených)`
          : 'Bez insolvence',
  });

  const rzpStatus = overview.registrationStatus['Živnostenský rejstřík'];
  checks.push({
    label: 'Živnosti',
    status: rzpStatus === 'AKTIVNI' ? '🟢' : '🟡',
    detail:
      rzpStatus === 'AKTIVNI'
        ? `Aktivní (${details?.tradeLicenses.length ?? 0} živností)`
        : (rzpStatus ?? 'N/A'),
  });

  const age = overview.dateEstablished
    ? Math.floor(
        (Date.now() - new Date(overview.dateEstablished).getTime()) /
          (365.25 * 24 * 60 * 60 * 1000),
      )
    : null;
  checks.push({
    label: 'Stáří firmy',
    status: age !== null && age >= 3 ? '🟢' : age !== null && age >= 1 ? '🟡' : '🔴',
    detail: age !== null ? `${age} let (od ${overview.dateEstablished})` : 'N/A',
  });

  const redCount = checks.filter((c) => c.status === '🔴').length;
  const yellowCount = checks.filter((c) => c.status === '🟡').length;
  const unknownCount = checks.filter((c) => c.status === '⚪').length;
  // An unresolved check outranks a clean one. A green overall verdict on a
  // health check that could not read the insolvency register is worse than
  // no verdict, because the reader cannot tell the difference.
  const overallStatus =
    redCount > 0
      ? '🔴 RIZIKO'
      : unknownCount > 0
        ? '⚪ NEÚPLNÉ'
        : yellowCount > 1
          ? '🟡 POZOR'
          : '🟢 OK';

  const lines: string[] = [
    `# ${overview.name} — Health Check`,
    '',
    `**Celkové hodnocení: ${overallStatus}**`,
    '',
    '| Kontrola | Stav | Detail |',
    '|----------|------|--------|',
    ...checks.map((c) => `| ${c.label} | ${c.status} | ${c.detail} |`),
    '',
    '## Souhrn',
    '',
    `Firma ${overview.name} (IČO ${overview.ico}) vykazuje celkový status: ${overallStatus}.`,
  ];

  if (unknownCount > 0) {
    lines.push(
      '',
      `⚠️ ${unknownCount} z ${checks.length} kontrol se nepodařilo provést — výsledek je neúplný. ` +
        'Nehodnoť firmu jako bezproblémovou na základě tohoto výstupu; zopakuj kontrolu později.',
    );
  }

  return lines.join('\n');
}

/**
 * The people whose other companies are worth looking up: sitting members of a
 * statutory body, plus natural-person shareholders.
 */
export function collectRelatedPeople(relations: CompanyRelations): Set<string> {
  const people = new Set<string>();
  for (const body of relations.statutoryBodies) {
    for (const member of body.members) {
      if (member.name && member.name !== 'N/A' && !member.until) {
        people.add(member.name);
      }
    }
  }

  for (const sh of relations.shareholders) {
    if (sh.type === 'person' && sh.name !== 'N/A') {
      people.add(sh.name);
    }
  }

  return people;
}

export function renderRelatedCompanies(
  relations: CompanyRelations,
  ico: string,
  people: Set<string>,
  relatedMap: RelatedCompaniesMap,
  failedSearches: string[],
): string {
  const lines: string[] = [
    `# Propojené firmy — ${relations.name} (IČO ${ico})`,
    '',
    `Nalezeno ${people.size} osob ve statutárních orgánech.`,
    '',
  ];

  if (relatedMap.size === 0 && failedSearches.length === people.size) {
    lines.push(
      'Vyhledávání se nepodařilo provést ani pro jednu z osob — rejstřík neodpověděl. ' +
        'To NENÍ zjištění, že propojené firmy neexistují; zkus to znovu později.',
    );
  } else if (relatedMap.size === 0) {
    lines.push('Žádné další firmy propojené přes statutární orgány nebyly nalezeny.');
  } else {
    for (const [person, data] of relatedMap) {
      lines.push(`## ${person}`, '');
      for (const c of data.companies) {
        lines.push(`- **${c.name}** (IČO: ${c.ico})`);
      }
      lines.push('');
    }
  }

  if (failedSearches.length > 0 && failedSearches.length < people.size) {
    lines.push(
      '',
      `⚠️ Pro ${failedSearches.length} z ${people.size} osob se vyhledávání nepodařilo provést ` +
        `(${failedSearches.join(', ')}). Výsledek je neúplný.`,
    );
  }

  return lines.join('\n');
}
