/**
 * Markdown rendering for ByzData tool and resource responses.
 *
 * Pure functions: registry data in, markdown out. Fetching, the
 * absent-vs-unavailable decision and the MCP response envelope all stay in
 * `server.ts` — nothing here reaches the network or decides an error code.
 */

import type { JusticeCompanyExtract, JusticeDocument } from './clients/justice-scraper.js';
import type {
  CompanyDetails,
  CompanyOverview,
  CompanyRelations,
  CompanySearchResult,
} from './types/company.js';
import type { IsirCase } from './types/isir.js';

export function renderSearchResults(query: string, results: CompanySearchResult[]): string {
  const text = results
    .map(
      (r, i) =>
        `${i + 1}. **${r.name}** (IČO: ${r.ico})\n` +
        `   Právní forma: ${r.legalForm ?? 'N/A'}\n` +
        `   Sídlo: ${r.address ?? 'N/A'}\n` +
        `   Datum vzniku: ${r.dateEstablished ?? 'N/A'}`,
    )
    .join('\n\n');

  return `Found ${results.length} companies matching "${query}":\n\n${text}`;
}

export function renderCompanyOverview(company: CompanyOverview): string {
  const activeRegs = Object.entries(company.registrationStatus)
    .filter(([, v]) => v === 'AKTIVNI')
    .map(([k]) => k);

  const capitalStr = company.shareCapital
    ? `${company.shareCapital.amount.toLocaleString('cs-CZ')} ${company.shareCapital.currency}`
    : null;

  const lines: string[] = [
    `# ${company.name}`,
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| IČO | ${company.ico} |`,
    `| DIČ | ${company.dic ?? 'N/A'} |`,
    `| Právní forma | ${company.legalForm ? `${company.legalForm.name} (${company.legalForm.code})` : 'N/A'} |`,
    `| Sídlo | ${company.address.full} |`,
    `| Datum vzniku | ${company.dateEstablished ?? 'N/A'} |`,
    `| Spisová značka | ${company.courtFile ?? 'N/A'} |`,
  ];

  if (capitalStr) {
    lines.push(`| Základní kapitál | ${capitalStr} |`);
    if (company.shareCapital?.paidUp) {
      lines.push(`| Splaceno | ${company.shareCapital.paidUp} |`);
    }
  }

  if (company.nace.length > 0) {
    lines.push('', '## CZ-NACE kódy', '', company.nace.join(', '));
  }

  if (activeRegs.length > 0) {
    lines.push('', '## Aktivní registrace', '', activeRegs.join(', '));
  }

  return lines.join('\n');
}

export function renderCompanyDetails(details: CompanyDetails): string {
  const lines: string[] = [`# ${details.name} — Details`, ''];

  if (details.businessActivities.length > 0) {
    lines.push('## Předmět podnikání (z obchodního rejstříku)', '');
    for (const a of details.businessActivities) {
      lines.push(`- ${a}`);
    }
    lines.push('');
  }

  if (details.tradeLicenses.length > 0) {
    lines.push('## Živnosti', '');
    lines.push('| Předmět | Druh | Od | Do |');
    lines.push('|---------|------|----|----|');
    for (const l of details.tradeLicenses) {
      lines.push(
        `| ${l.subject} | ${l.type ?? 'N/A'} | ${l.dateFrom ?? 'N/A'} | ${l.dateTo ?? 'trvá'} |`,
      );
    }
    lines.push('');
  }

  if (details.naceActivities.length > 0) {
    lines.push('## CZ-NACE kódy', '', details.naceActivities.join(', '));
  }

  return lines.join('\n');
}

export function renderCompanyRelations(relations: CompanyRelations): string {
  const lines: string[] = [`# ${relations.name} — Relations`, ''];

  if (relations.statutoryBodies.length > 0) {
    for (const body of relations.statutoryBodies) {
      lines.push(`## ${body.organName}`, '');
      if (body.representation) {
        lines.push(`**Způsob jednání:** ${body.representation}`, '');
      }
      if (body.members.length > 0) {
        lines.push('| Jméno | Funkce | Od | Do |');
        lines.push('|-------|--------|----|----|');
        for (const m of body.members) {
          lines.push(
            `| ${m.name} | ${m.role ?? 'člen'} | ${m.since ?? 'N/A'} | ${m.until ?? 'trvá'} |`,
          );
        }
        lines.push('');
      }
    }
  }

  if (relations.shareholders.length > 0) {
    lines.push('## Společníci / Akcionáři', '');
    lines.push('| Jméno | Typ | Vklad | Podíl |');
    lines.push('|-------|-----|-------|-------|');
    for (const s of relations.shareholders) {
      const shareStr = s.share
        ? `${s.share.amount?.toLocaleString('cs-CZ') ?? 'N/A'} ${s.share.currency ?? ''}`
        : 'N/A';
      const pctStr = s.share?.percentage != null ? `${s.share.percentage}%` : 'N/A';
      lines.push(`| ${s.name} | ${s.type === 'company' ? 'PO' : 'FO'} | ${shareStr} | ${pctStr} |`);
    }
  }

  if (relations.statutoryBodies.length === 0 && relations.shareholders.length === 0) {
    lines.push('No statutory bodies or shareholders found in the commercial register.');
  }

  return lines.join('\n');
}

export function renderDocumentList(ico: string, documents: JusticeDocument[]): string {
  const lines: string[] = [
    `# Sbírka listin — IČO ${ico}`,
    '',
    `Found ${documents.length} documents.`,
    '',
    '| Číslo listiny | Typ | Vznik | Došlo na soud | Stránek |',
    '|---------------|-----|-------|---------------|---------|',
  ];

  for (const doc of documents) {
    lines.push(
      `| ${doc.code} | ${doc.type} | ${doc.dateCreated ?? '—'} | ${doc.dateReceived ?? '—'} | ${doc.pages ?? '?'} |`,
    );
  }

  return lines.join('\n');
}

export function renderCompanyExtract(ico: string, extract: JusticeCompanyExtract): string {
  const lines: string[] = [
    '# Výpis z obchodního rejstříku',
    '',
    '| Údaj | Hodnota |',
    '|------|---------|',
    `| Obchodní firma | ${extract.name ?? 'N/A'} |`,
    `| Spisová značka | ${extract.courtFile ?? 'N/A'} |`,
    `| Datum vzniku | ${extract.dateEstablished ?? 'N/A'} |`,
    `| Sídlo | ${extract.address ?? 'N/A'} |`,
    `| IČO | ${extract.ico ?? ico} |`,
    `| Právní forma | ${extract.legalForm ?? 'N/A'} |`,
    `| Základní kapitál | ${extract.shareCapital ?? 'N/A'} |`,
  ];

  if (extract.businessActivities.length > 0) {
    lines.push('', '## Předmět podnikání', '');
    for (const activity of extract.businessActivities) {
      lines.push(activity);
    }
  }

  if (extract.statutoryBody) {
    lines.push('', `## ${extract.statutoryBody.type}`, '');
    if (extract.memberCount) {
      lines.push(`Počet členů: ${extract.memberCount}`);
    }
    if (extract.representation) {
      lines.push(`Způsob jednání: ${extract.representation}`);
    }
    lines.push('');
    for (const m of extract.statutoryBody.members) {
      lines.push(`### ${m.role ?? 'Člen'}`, `- **Jméno:** ${m.name}`);
      if (m.dateOfBirth) lines.push(`- **Datum narození:** ${m.dateOfBirth}`);
      if (m.address) lines.push(`- **Adresa:** ${m.address}`);
      if (m.functionSince) lines.push(`- **Den vzniku funkce:** ${m.functionSince}`);
      lines.push('');
    }
  }

  if (extract.shareholders.length > 0) {
    lines.push('## Společníci', '');
    for (const s of extract.shareholders) {
      lines.push(`### ${s.name}`);
      if (s.dateOfBirth) lines.push(`- **Datum narození:** ${s.dateOfBirth}`);
      if (s.address) lines.push(`- **Adresa:** ${s.address}`);
      if (s.share) {
        if (s.share.contribution) lines.push(`- **Vklad:** ${s.share.contribution}`);
        if (s.share.paidUp) lines.push(`- **Splaceno:** ${s.share.paidUp}`);
        if (s.share.businessShare) {
          lines.push(`- **Obchodní podíl:** ${s.share.businessShare}`);
        }
      }
      lines.push('');
    }
  }

  if (extract.otherFacts.length > 0) {
    lines.push('## Ostatní skutečnosti', '');
    for (const fact of extract.otherFacts) {
      lines.push(`- ${fact}`);
    }
  }

  return lines.join('\n');
}

export function renderInsolvencyCases(ico: string, cases: IsirCase[]): string {
  const lines: string[] = [
    `**IČO ${ico} — Insolvence: ANO** (${cases.length} řízení)`,
    '',
    '| Spisová značka | Soud | Stav | Zahájeno | Ukončeno |',
    '|----------------|------|------|----------|----------|',
  ];

  for (const c of cases) {
    lines.push(
      `| ${c.spisovaZnacka ?? 'N/A'} | ${c.soud ?? 'N/A'} | ${c.druhStavRizeni ?? 'N/A'} | ${c.datumZalozeni ?? 'N/A'} | ${c.datumUkonceni ?? '—'} |`,
    );
  }

  return lines.join('\n');
}

// ── Resource bodies ────────────────────────────────────────────

export function renderOverviewResource(overview: CompanyOverview): string {
  return [
    `# ${overview.name}`,
    `IČO: ${overview.ico}`,
    `DIČ: ${overview.dic ?? 'N/A'}`,
    `Právní forma: ${overview.legalForm?.name ?? 'N/A'}`,
    `Sídlo: ${overview.address.full}`,
    `Datum vzniku: ${overview.dateEstablished ?? 'N/A'}`,
    `Spisová značka: ${overview.courtFile ?? 'N/A'}`,
    overview.shareCapital
      ? `Základní kapitál: ${overview.shareCapital.amount.toLocaleString('cs-CZ')} ${overview.shareCapital.currency}`
      : '',
    `CZ-NACE: ${overview.nace.join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderRelationsResource(relations: CompanyRelations): string {
  const lines: string[] = [`# ${relations.name} — Relations`];
  for (const body of relations.statutoryBodies) {
    lines.push(`\n## ${body.organName}`);
    for (const m of body.members) {
      lines.push(`- ${m.name} (${m.role ?? 'člen'}, od ${m.since ?? 'N/A'})`);
    }
  }
  if (relations.shareholders.length > 0) {
    lines.push('\n## Společníci');
    for (const s of relations.shareholders) {
      const pct = s.share?.percentage != null ? ` — ${s.share.percentage}%` : '';
      lines.push(`- ${s.name}${pct}`);
    }
  }
  return lines.join('\n');
}

export function renderDocumentsResource(ico: string, docs: JusticeDocument[]): string {
  const lines = [`# Sbírka listin — IČO ${ico}`, `${docs.length} documents`, ''];
  for (const doc of docs) {
    lines.push(`- ${doc.code}: ${doc.type} (${doc.dateCreated ?? 'N/A'})`);
  }
  return lines.join('\n');
}
