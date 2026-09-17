/**
 * The OIDs whose `pg-types` default loses or invents information, and the
 * per-client overrides that return the text PostgreSQL sent instead.
 */
import pg from 'pg';
// The very parser `pg-types` uses for every array OID, pinned to the version it
// depends on (`pg-types@2.2.0` → `postgres-array@~2.0.0`). Imported directly so
// the OID 1115 override below reuses PostgreSQL's array-literal grammar —
// quoting, embedded commas, backslash escapes, `NULL` — instead of a
// hand-written split that would get one of them wrong. Declared as a direct
// dependency of this package rather than relied on through hoisting.
import postgresArray from 'postgres-array';

/**
 * OIDs returned as the exact text PostgreSQL sent, instead of `pg-types`'
 * default parse.
 *
 * All three defaults lose or invent information the model then reports as fact:
 *
 * - `1082` `date` and `1114` `timestamp without time zone` are parsed into a
 *   `Date` built from the **process's local offset**, so `Date.toJSON()` shifts
 *   the value by the container's zone and pins a `Z` onto a reading that never
 *   claimed to be an instant. For `date` the shift crosses a whole calendar
 *   day: under `TZ=Europe/Prague`, `'2024-06-01'::date` reaches the model as
 *   `"2024-05-31T22:00:00.000Z"` — the wrong day, in a payload that looks
 *   authoritative. Zero shift in a UTC container, which is why both stay
 *   invisible until someone sets `TZ`.
 * - `1700` `numeric` is *already* text by default (arbitrary precision does not
 *   survive a double), and this list does not change that — it is named here
 *   only because `1231` `numeric[]` below has to match it.
 *
 * `1184`/`1185` (`timestamptz`, `timestamptz[]`) are deliberately absent: those
 * denote real instants, so their ISO strings are correct in any zone.
 *
 * Typed through `setTypeParser`'s own parameter because `@types/pg` declares it
 * as `pg-types`' `TypeId` enum, which a bare `1114` is not assignable to.
 */
const RAW_TEXT_OIDS = [
  1082, // date
  1114, // timestamp without time zone
] as const;

/**
 * Array OIDs whose *elements* are returned as the text PostgreSQL sent.
 *
 * Each one needs its own override rather than inheriting the scalar's:
 * `pg-types` parses every array OID as `postgresArray.parse(value, transform)`
 * where `transform` is a reference it holds internally, so a scalar override
 * registered on the client never reaches the elements of an array. That is why
 * `timestamp[]` kept arriving shifted after `timestamp` was already correct.
 *
 * - `1182` `date[]` and `1115` `timestamp[]` — the local-offset shift above,
 *   one level down.
 * - `1231` `numeric[]` — `pg-types` parses these elements with `parseFloat`
 *   while scalar `numeric` comes back as exact text. So `ARRAY[0.10]::numeric[]`
 *   became `[0.1]` and a value past 2^53 lost digits outright, in the same
 *   payload where a `numeric` column was exact. Matching the scalar is the
 *   whole point.
 */
const RAW_TEXT_ELEMENT_ARRAY_OIDS = [
  1115, // timestamp without time zone[]
  1182, // date[]
  1231, // numeric[]
] as const;

/**
 * One array value with its elements left as the text PostgreSQL sent.
 *
 * The array structure is produced by the *same* parser `pg-types` uses —
 * `postgresArray.parse(value, transform)` — with the transform reduced to
 * identity. So quoted elements, embedded commas, backslash escapes and `NULL`
 * (which the parser never hands to the transform) all behave exactly as they
 * did; only the element type changes.
 *
 * The empty-value guard mirrors `pg-types`' own (`if (!value) return null`), so
 * the override differs from the original in nothing but the element type.
 */
function parseArrayOfRawText(value: string): unknown {
  if (!value) return null;
  return postgresArray.parse(value, (element) => element);
}

/**
 * Registers this package's type overrides on **one** `pg.Client`.
 *
 * Per client, never through the global `pg.types`: `Client` builds its own
 * `TypeOverrides` (pg 8.23 `lib/client.js:77`), hands it to every result
 * (`:744`), and `setTypeParser` writes into it (`:598`). Other PostgreSQL
 * consumers can share the process, so a global mutation from here would
 * change how their values come back.
 */
export function applyTypeParsers(client: pg.Client): void {
  type Oid = Parameters<pg.Client['setTypeParser']>[0];
  for (const oid of RAW_TEXT_OIDS) {
    client.setTypeParser(oid as Oid, (value: string) => value);
  }
  for (const oid of RAW_TEXT_ELEMENT_ARRAY_OIDS) {
    client.setTypeParser(oid as Oid, parseArrayOfRawText);
  }
}
