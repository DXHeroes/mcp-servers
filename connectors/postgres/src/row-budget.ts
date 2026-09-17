/**
 * Spending the call's shared row and byte budget on the rows as they arrive,
 * and shaping each kept row into the payload that goes out.
 */
import { SecretScrubber } from '@dxheroes/mcp-kit';
import type { ResultBudget, StatementRows } from './result-envelope.js';

/**
 * `NaN` and `±Infinity` in PostgreSQL's own spelling.
 *
 * `pg-types` parses `float4`/`float8` with `parseFloat`, so `'NaN'::float8`
 * really does arrive as JS `NaN` — and `JSON.stringify` renders every
 * non-finite number as `null`, which the model cannot tell apart from a SQL
 * NULL. On measurement or financial data that is a silent substitution of one
 * answer for another, so the value is projected to the text PostgreSQL accepts
 * and prints instead.
 */
function nonFiniteSpelling(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  return value > 0 ? 'Infinity' : '-Infinity';
}

/**
 * The `JSON.stringify` replacer every row goes through.
 *
 * Two values would otherwise be lost or fatal:
 *
 * - a non-finite number is rendered as `null`, which the model cannot tell from
 *   a SQL NULL (see `nonFiniteSpelling`);
 * - a `BigInt` makes `JSON.stringify` **throw** —
 *   `TypeError: Do not know how to serialize a BigInt`. Thrown from here that
 *   used to escape `buildEnvelope` and fail the whole tool call as an opaque
 *   `PG_ERROR`, destroying every other statement's result in a batch to report
 *   one column. It is projected to its exact decimal text, the same treatment
 *   `numeric` gets, because a `BigInt` exists precisely where a `number` would
 *   have lost digits.
 */
function jsonSafeValue(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) return nonFiniteSpelling(value);
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * Stands in for a row that could not be serialised at all.
 *
 * `jsonSafeValue` covers the two values known to arrive from `pg`, but a custom
 * type parser (or a future driver change) can put anything in a row, and
 * `JSON.stringify` throws on a circular structure too. One unrepresentable row
 * must not cost the caller the other rows, the other statements, or the
 * `row_count` — so the row is replaced and says why, and nothing else about
 * the call changes.
 */
function unserialisableRow(error: unknown): unknown {
  const reason = error instanceof Error ? error.message : 'unknown error';
  return {
    mcp_error: 'ROW_NOT_SERIALISABLE',
    message: `This row held a value that cannot be represented in JSON (${reason}), so the row itself was replaced. Every other row and statement of this call is unaffected; re-select the columns you need individually, or cast the offending one to text.`,
  };
}

/**
 * The same replacement with no reason read off the error, for the last-resort
 * guard in `take()`.
 *
 * Pre-built and pre-measured so the guard needs no allocation, no
 * `JSON.stringify` and no property access on the thrown value: it runs where a
 * second throw would be an `uncaughtException` (see `take`), so it may not do
 * anything that could throw again.
 *
 * The `+ 1` is the comma or bracket this row costs in the serialised array,
 * exactly as in `measureRow` — the replacement is charged for like any other
 * row, and a budget that ignored the separators would let `rows` past the
 * documented cap by one byte per row.
 */
const UNSERIALISABLE_ROW = Object.freeze({
  mcp_error: 'ROW_NOT_SERIALISABLE',
  message:
    'This row could not be turned into JSON at all, so the row itself was replaced. Every other row and statement of this call is unaffected; re-select the columns you need individually, or cast the wide or unusual ones to text.',
});
const UNSERIALISABLE_ROW_BYTES = Buffer.byteLength(JSON.stringify(UNSERIALISABLE_ROW), 'utf8') + 1;

/**
 * A **lower bound**, in UTF-8 bytes, on what one raw driver value costs in the
 * shaped payload — or 0 for a value whose cost cannot be read off it.
 *
 * Zero is a valid answer here: the number is only ever used to refuse a row
 * that cannot fit, so under-counting costs nothing but the full measurement
 * that would have happened anyway. Over-counting is the bug, and there are two
 * directions to get it wrong.
 *
 * A `Buffer` contributes its full length, which is safe because shaping only
 * ever makes it bigger: `bytea` serialises as `{"type":"Buffer","data":[…]}`,
 * roughly five times that, and the scrubber cannot shrink a JSON byte array
 * (its only strings are `"type"` and `"Buffer"`, both far below
 * `minSecretLength`).
 *
 * A **string is measured after `scrubText`**, and that is a fix rather than
 * caution. The scrubber *shrinks* strings — every occurrence of a registered
 * secret becomes the 17-byte `[REDACTED-SECRET]` — so the raw length is not a
 * lower bound on the shaped size at all. Measured: with the credential
 * `postgresql://alice:…@db.example.com:5432/shop?sslmode=require` (78 bytes)
 * registered, one `text` column holding it 4000 times over is 324,000 raw
 * bytes and 72,008 shaped bytes against a 256,000-byte allowance — so the raw
 * floor refused, with `returned: 0` and `truncated_reason: byte_limit`, a row
 * that fitted with room to spare. Silent data loss, and a "lower bound" that
 * was not one.
 *
 * Running the scrub here rather than estimating its effect is what makes the
 * number exact instead of merely conservative. Estimating was tried and is not
 * sound: the shrink a *sequence* of substitutions can achieve is not bounded by
 * any single ratio, because a later secret can match text an earlier
 * replacement created. The cost is one extra `scrubText` per string per row —
 * `String.includes` per registered secret, and no allocation at all unless
 * there is something to replace — against a shaping step that serialises,
 * parses, scrubs and serialises again.
 *
 * `extraSecrets` are deliberately not passed, and cannot matter: they come from
 * capture patterns and redacted key stems, and the scrubber built in the
 * constructor below configures neither. Adding either would make this an
 * over-count and belongs with a change here.
 */
function rawValueFloor(value: unknown, scrubber: SecretScrubber): number {
  if (typeof value === 'string') return Buffer.byteLength(scrubber.scrubText(value), 'utf8');
  if (Buffer.isBuffer(value)) return value.length;
  return 0;
}

/**
 * A lower bound on the serialised size of a raw driver row, stopping as soon
 * as it passes `limit`.
 *
 * This is what keeps the memory bound honest for the one shape that used to
 * break it: `shapeRow` stringifies, parses, scrubs and stringifies again, so a
 * row transiently costs a multiple of its wire size — measured at ~24× for a
 * 20 MB `bytea`, which is a V8 out-of-memory abort of the whole host under a
 * 192 MB heap even though the row was always going to be refused. Reading the
 * size off the raw value first refuses it for nothing.
 *
 * Deliberately **not recursive**. It looks at the row's own values and one
 * level into an array (which is where `text[]`/`bytea[]` elements live), and
 * stops: a `json`/`jsonb` column arrives already parsed into objects and
 * arrays of unbounded depth, and recursing into one would re-create the stack
 * overflow this file's `take()` guard exists to survive.
 */
function rawRowFloor(row: unknown, limit: number, scrubber: SecretScrubber): number {
  if (row === null || typeof row !== 'object') return rawValueFloor(row, scrubber);
  let floor = 0;
  for (const value of Object.values(row as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const element of value) {
        floor += rawValueFloor(element, scrubber);
        if (floor > limit) return floor;
      }
      continue;
    }
    floor += rawValueFloor(value, scrubber);
    if (floor > limit) return floor;
  }
  return floor;
}

/**
 * Spends the call's shared budget on one arriving row, and **cannot throw**.
 *
 * That is not defensive habit, it is the whole contract of this method. It is
 * called from the `'row'` listener in `streamStatements`, which `pg` emits
 * from `handleDataRow` (pg 8.23 `lib/query.js:96`) — outside pg's own `try`
 * (which wraps only `parseRow`) and inside a socket `data` callback, so
 * outside `withConnection`'s `try` and outside every promise. A throw there
 * is an `uncaughtException` that can terminate the connector process and its
 * other active calls. It also aborts pg's parse loop, so
 * `ReadyForQuery` is never processed and the tool call hangs to the client
 * deadline and then reports a `QUERY_TIMEOUT` that never happened.
 *
 * It really happens. `SELECT (repeat('[',1900) || '1' || repeat(']',1900))::jsonb`
 * overflows the stack inside `SecretScrubber.scrubValue` (one frame per
 * nesting level, and pg's own frames are already on the stack, so it gives
 * out at a shallower depth than `JSON.stringify` does) — measured against
 * PostgreSQL 17, process exit code 1.
 *
 * So every failure degrades to a replacement row for that row alone:
 * `measureRow` catches what shaping and measuring can throw and says why,
 * and the guard here catches anything left — a throwing getter on the driver
 * row, a `RangeError` from reading the reason — with a pre-built constant
 * that needs no allocation of its own. Losing the row silently is not an
 * option either: `returned` below `row_count` with `has_more: false` is the
 * envelope lying, so the replacement takes the row's place in `rows` and
 * charges the budget for it.
 */
export function take(
  collector: StatementRows,
  row: unknown,
  budget: ResultBudget,
  scrubber: SecretScrubber,
): void {
  try {
    spendOnRow(collector, row, budget, scrubber);
  } catch {
    // The replacement is charged for like any other row, and it goes through
    // the same two gates. It used to skip them — `budget.bytes -=` with no
    // check and no `collector.reason` — which is the envelope lying twice
    // over: measured with 1000 rows whose every column throws on access,
    // `returned: 1000`, 273,001 bytes of `rows` (1.07× the documented
    // ~256 kB cap) and `has_more: false` with no `truncated_reason`. Only
    // arithmetic and pushes onto this collector's own array happen here, so
    // the "cannot throw" contract above still holds.
    if (collector.reason !== undefined) return;
    if (budget.rows <= 0) {
      collector.reason = 'row_limit';
      return;
    }
    if (UNSERIALISABLE_ROW_BYTES > budget.bytes) {
      collector.reason = 'byte_limit';
      return;
    }
    collector.rows.push(UNSERIALISABLE_ROW);
    budget.rows -= 1;
    budget.bytes -= UNSERIALISABLE_ROW_BYTES;
  }
}

/**
 * The budget arithmetic for one arriving row. Only ever called through
 * `take`, which is what makes it safe for this to be able to throw.
 *
 * Order matters twice over. The row allowance is checked **before** the row
 * is shaped, so a result past the cap costs nothing at all to skip. Then the
 * row's raw size is checked, which is what bounds the peak: shaping costs a
 * multiple of the row (serialise → parse → scrub → serialise), so a 20 MB
 * `bytea` that was never going to fit used to cost ~480 MB to find that out —
 * a V8 abort under a small heap. A row whose raw `string`/`Buffer` columns
 * already exceed the remaining allowance is refused from those lengths
 * alone. Once a statement has been cut it stays cut: the rows still arriving
 * are read off the socket and discarded, which is what keeps `rows` a
 * contiguous prefix of the result rather than a set with holes in it.
 */
function spendOnRow(
  collector: StatementRows,
  row: unknown,
  budget: ResultBudget,
  scrubber: SecretScrubber,
): void {
  if (collector.reason !== undefined) return;
  if (budget.rows <= 0) {
    collector.reason = 'row_limit';
    return;
  }
  if (rawRowFloor(row, budget.bytes, scrubber) > budget.bytes) {
    collector.reason = 'byte_limit';
    return;
  }
  const { shaped, size } = measureRow(row, scrubber);
  if (size > budget.bytes) {
    collector.reason = 'byte_limit';
    return;
  }
  budget.bytes -= size;
  budget.rows -= 1;
  collector.rows.push(shaped);
}

/**
 * One row shaped, and what it costs the byte budget.
 *
 * Measuring is inside the guard with the shaping, because the measurement
 * can fail on its own after the shaping succeeded — and a throw from here
 * lands in pg's `'row'` handler, where it ends the connector host process (see
 * `take`).
 *
 * The reachable failure is **growth**, not depth. The scrub makes a payload
 * *bigger* when a registered secret is shorter than the 17-byte
 * `[REDACTED-SECRET]` that replaces it (the floor is 8 characters, so up to
 * ~2.1×), so a `json`/`jsonb` value that serialised comfortably inside V8's
 * ~512 MB string limit can scrub past it, and the `JSON.stringify` here then
 * throws `RangeError: Invalid string length`. It has to be a `json`/`jsonb`
 * structure: `rawValueFloor` measures a plain `string` column *after* the
 * scrub, so a grown one is refused before it is ever shaped.
 *
 * Depth was the earlier claim and measurement does not support it in the
 * order it implies: `SecretScrubber.scrubValue` gives out at a shallower
 * nesting level than `JSON.stringify` does (~1800 against a structure
 * `JSON.stringify` still handles), so a stack overflow always lands in
 * `shapeRow`'s guard, one step earlier. Reproducing the growth case needs a
 * payload of a few hundred megabytes, which is why there is no test for this
 * guard and there is one for `shapeRow`'s.
 */
function measureRow(row: unknown, scrubber: SecretScrubber): { shaped: unknown; size: number } {
  try {
    const shaped = shapeRow(row, scrubber);
    // Bytes, not `String.length`: UTF-16 code units undercount Czech text and
    // any other non-ASCII payload by two to three times, which would let a
    // documented ~256 kB cap pass over 700 kB. +1 for the comma or bracket
    // this row costs in the serialised array.
    return { shaped, size: Buffer.byteLength(JSON.stringify(shaped ?? null), 'utf8') + 1 };
  } catch (error) {
    const shaped = unserialisableRow(error);
    return { shaped, size: Buffer.byteLength(JSON.stringify(shaped), 'utf8') + 1 };
  }
}

/**
 * One driver row turned into the payload that will go out.
 *
 * Serialise first, then scrub — in that order, and never the other way round
 * on a raw driver row. `SecretScrubber.scrub()` rebuilds every object from
 * `Object.entries()`, and a `Date` has no own enumerable properties: it would
 * come back as `{}`. A `Buffer` would come back as an index→byte map, five
 * times the size. `pg` parses `timestamptz` to `Date` and `bytea` to
 * `Buffer`, so a structural scrub over the driver's own objects silently
 * empties the most ordinary column there is, with nothing in the envelope to
 * say it happened.
 *
 * The JSON round-trip is what the caller receives anyway (a `Date` becomes
 * its ISO string, a `Buffer` becomes `{type,data}`), so the scrubber sees
 * exactly the payload that will go out — which is also what keeps the
 * "scrub before compaction" rule intact: the byte budget drops rows, and a
 * credential in a dropped row must never be the reason it was missed.
 * Value-based only — see the note in the constructor.
 */
function shapeRow(row: unknown, scrubber: SecretScrubber): unknown {
  try {
    const serialised = JSON.stringify(row, jsonSafeValue) ?? 'null';
    // Inside the same `try` as the stringify, and that is the fix for a
    // process-killing regression: `SecretScrubber.scrubValue` recurses once
    // per nesting level with no depth cap, so a deep `jsonb` value overflows
    // the stack *here* — and this runs in pg's `'row'` handler, where an
    // escaping throw ends the connector host (see `take`). The guard used to cover
    // only the stringify, which is the one of the two that could not fail
    // first.
    return scrubber.scrub(JSON.parse(serialised) as unknown);
  } catch (error) {
    return unserialisableRow(error);
  }
}
