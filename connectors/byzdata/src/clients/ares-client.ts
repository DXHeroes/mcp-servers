import type {
  AresRzpResponse,
  AresSearchResponse,
  AresSubject,
  AresVrResponse,
} from '../types/ares.js';
import { padIco } from '../utils/formatters.js';
import { fetchJson, fetchJsonOrNull, HttpError } from '../utils/http.js';

const BASE_URL = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest';

export class AresClient {
  /**
   * Full-text search over the register.
   *
   * Uses `fetchJson`, not `fetchJsonOrNull`: a 404 on the *search* endpoint is
   * not "zero matches" — the register returns a normal 200 with an empty list
   * for that. Treating it as an empty result set (which is what the previous
   * `result ?? { pocetCelkem: 0 }` did) meant a broken endpoint read to the
   * model as "no such company".
   */
  async searchSubjects(query: string, limit: number = 10): Promise<AresSearchResponse> {
    const url = `${BASE_URL}/ekonomicke-subjekty/vyhledat`;
    return fetchJson<AresSearchResponse>(url, {
      source: 'ARES',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        obchodniJmeno: query,
        pocet: Math.min(limit, 100),
        start: 0,
      }),
    });
  }

  /** Lookup by IČO. A 404 here really is "no subject with this IČO". */
  async getSubject(ico: string): Promise<AresSubject | null> {
    const url = `${BASE_URL}/ekonomicke-subjekty/${padIco(ico)}`;
    return fetchJsonOrNull<AresSubject>(url, { source: 'ARES' });
  }

  async getVrDetail(ico: string): Promise<AresVrResponse | null> {
    const url = `${BASE_URL}/ekonomicke-subjekty-vr/${padIco(ico)}`;
    return this.subRegisterLookup<AresVrResponse>(url);
  }

  async getRzpDetail(ico: string): Promise<AresRzpResponse | null> {
    const url = `${BASE_URL}/ekonomicke-subjekty-rzp/${padIco(ico)}`;
    return this.subRegisterLookup<AresRzpResponse>(url);
  }

  /**
   * VR (commercial register) and RZP (trade register) sub-lookups.
   *
   * These answer 400, not 404, for a subject that exists in ARES but has no
   * record in that particular sub-register — a sole trader has RZP but no VR.
   * The IČO reaching here has already passed the tool's `^\d{1,8}$` check and
   * been zero-padded, so a 400 is far more likely to mean "not in this
   * register" than "malformed". Every other status still propagates, so an
   * unavailable register cannot be rendered as an absent record.
   *
   * (Observed from the register's behaviour, not from its published error
   * catalogue — the 400 mapping predates this change and is kept as-is.)
   */
  private async subRegisterLookup<T>(url: string): Promise<T | null> {
    try {
      return await fetchJsonOrNull<T>(url, { source: 'ARES' });
    } catch (error) {
      if (error instanceof HttpError && error.status === 400) {
        return null;
      }
      throw error;
    }
  }
}
