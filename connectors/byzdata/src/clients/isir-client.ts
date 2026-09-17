import type { IsirCase, IsirSearchResponse } from '../types/isir.js';
import { ByzdataError, fetchJson } from '../utils/http.js';

const EISIR_URL = 'https://eisir.justice.cz/vir/api/v1/rizeni/vyhledatDleDluznika';

export class IsirClient {
  /**
   * Look up insolvency proceedings for a company.
   *
   * Throws rather than returning `[]` when the register does not answer.
   * Returning an empty list on failure is what made this the most dangerous
   * call in the package: an empty list renders as "Insolvence: NE", so an
   * unreachable eISIR produced a clean bill of health for a company that may
   * well be in insolvency. An empty list now means one thing only — the
   * register answered and had nothing.
   */
  async checkInsolvency(ico: string): Promise<IsirCase[]> {
    const icNumber = Number.parseInt(ico, 10);
    if (Number.isNaN(icNumber)) {
      throw new ByzdataError(
        `"${ico}" is not a numeric IČO, so the insolvency register cannot be queried.`,
        'BAD_REQUEST',
        'ISIR',
      );
    }

    const data = await fetchJson<IsirSearchResponse>(EISIR_URL, {
      source: 'ISIR',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paging: { page: 1, size: 20 },
        filter: { ic: icNumber },
      }),
    });

    return data.list ?? [];
  }
}
