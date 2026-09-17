/**
 * Payload compaction — what this client leaves out of a Toggl response, and how
 * it says so.
 *
 * Split out of `client.ts`. Everything here is pure: it transforms a payload
 * that has already been scrubbed, and it never reaches the network. Compaction
 * runs strictly *after* scrubbing, never before it — see `client.http.ts`.
 */

// ── Payload compaction ───────────────────────────────────────────────

/**
 * Legacy aliases Toggl still returns beside their modern names.
 *
 * Toggl's own API definition annotates each of these as a "legacy field" and
 * documents the canonical key right next to it, so on a time entry both `pid`
 * and `project_id` carry the same project. Every one of them is paid for
 * twice: once in the model's context window and once in the connector host's debug
 * log.
 *
 * The alias is dropped **only when its canonical twin is present in the same
 * object with an equal value** — the point is to remove a proven duplicate,
 * not to guess. If Toggl ever returns them with different meanings (`uid` is
 * documented as the *creator*, which need not be the assignee some other
 * endpoint puts in `user_id`), or omits the canonical key on some endpoint,
 * nothing is lost: the alias survives untouched.
 */
export const LEGACY_ID_ALIASES: ReadonlyMap<string, string> = new Map([
  ['uid', 'user_id'],
  ['wid', 'workspace_id'],
  ['pid', 'project_id'],
  ['tid', 'task_id'],
]);

/**
 * Removes legacy id aliases that provably duplicate a key in the same object.
 *
 * Applied recursively, after scrubbing, to every payload — the same choke
 * point rather than per call site. It cannot expose a secret: it only ever
 * deletes a key whose value is a number identical to one that stays.
 */
export function dropDuplicateAliases<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => dropDuplicateAliases(item)) as unknown as T;
  }
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    const canonical = LEGACY_ID_ALIASES.get(key);
    if (canonical !== undefined && canonical in record && record[canonical] === nested) {
      continue;
    }
    result[key] = dropDuplicateAliases(nested);
  }
  return result as T;
}

/**
 * Removes keys whose value is `null`, recursively.
 *
 * Generic on purpose. An earlier attempt at this named the fields to drop —
 * `server_deleted_at`, the `rate*` family, `estimated_*`, `fixed_fee` — on the
 * evidence that they were always null on one workspace. They are real premium
 * fields on somebody else's, and "always null here" is not "always null".
 * Dropping by *value* cannot make that mistake: a field that carries data
 * keeps it.
 *
 * It does cost something, which is why it is not applied everywhere (see
 * {@link compactList}): "Toggl returned null" and "Toggl did not
 * return this key" stop being distinguishable. That is the same distinction
 * the secret redaction preserves by replacing values instead of deleting keys,
 * so it is only spent where the saving is real — the list payloads — and where
 * the wrapper around them can say out loud that it happened.
 */
export function dropNullValues<T>(value: T, removed?: { count: number }): T {
  if (Array.isArray(value)) {
    return value.map((item) => dropNullValues(item, removed)) as unknown as T;
  }
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (nested === null) {
      if (removed) removed.count += 1;
      continue;
    }
    result[key] = dropNullValues(nested, removed);
  }
  return result as T;
}

/**
 * Default number of projects returned when the caller names no page size.
 *
 * Toggl paginates this endpoint but applies no default of its own, so a
 * workspace with a few hundred projects answered a single unparameterised call
 * with something on the order of 190,000 characters — most of it fields the
 * question did not need. Pagination existed all along; without a default the
 * model simply never reached for it.
 */
export const DEFAULT_PROJECTS_PER_PAGE = 50;

/**
 * Default number of time entries returned.
 *
 * Unlike projects this is a client-side slice, because `GET /me/time_entries`
 * has no `limit` and no `page` — Toggl's API definition gives it `since`,
 * `before`, `start_date` and `end_date` and nothing else. The entries are
 * fetched in full and cut here, which bounds what reaches the model and the
 * debug log even though it cannot bound the upstream response.
 */
export const DEFAULT_TIME_ENTRY_LIMIT = 50;

/** Ceiling on the client-side slice, mirroring the paging caps elsewhere. */
export const MAX_TIME_ENTRY_LIMIT = 200;

/**
 * Wraps a list payload in an envelope that says what was left out.
 *
 * A bare array that has been cut is indistinguishable from a complete one,
 * which is the same class of dishonesty as a filter that is silently
 * dropped: the model reads it as the whole answer and reports it as such.
 * The envelope carries the count and how to get the rest, and it is also
 * where {@link dropNullValues} is admitted to — dropping nulls saves real
 * size on a list, but it costs the difference between "Toggl returned null"
 * and "Toggl did not return this key", and that trade should be stated
 * where it is made rather than left for the model to infer.
 *
 * A non-array payload is returned untouched: Toggl answering a listing with
 * something other than a list is not a list to compact, and inventing an
 * envelope around it would hide that.
 */
export function compactList(
  payload: unknown,
  envelope: (items: unknown[]) => Record<string, unknown>,
): unknown {
  if (!Array.isArray(payload)) return payload;
  const removed = { count: 0 };
  const base = envelope(dropNullValues(payload, removed));
  // Said only when it happened. The note used to be a constant, so a listing
  // that dropped nothing still paid ~330 characters to say something untrue
  // about itself — in a change whose whole point is to spend less context.
  if (removed.count === 0) return base;
  return {
    ...base,
    // Named for what it is: a sentence about this response, not the list of
    // keys the name `omitted_keys` promised. A model reading `omitted_keys`
    // expects an array it can iterate.
    compaction_note: `${removed.count} null-valued ${removed.count === 1 ? 'key was' : 'keys were'} removed from the items above to save space. So a key missing from an item was either null in Toggl's response or never sent by it — this cannot tell those apart, and a missing key is not evidence that Toggl reported a value.`,
  };
}

/**
 * Envelope for a time entry listing.
 *
 * Lives here rather than inline at the call site so that every statement this
 * client makes about what it left out of a list sits next to {@link compactList},
 * which is what adds the note about dropped nulls to the same object.
 */
export function timeEntriesEnvelope(
  items: unknown[],
  effectiveLimit: number,
): Record<string, unknown> {
  return {
    time_entries: items.slice(0, effectiveLimit),
    returned: Math.min(items.length, effectiveLimit),
    // Exact about the cut, and only about the cut: the whole array Toggl sent
    // was fetched, so whether *this client* dropped anything is known rather
    // than inferred from a full page. What was verified is that the endpoint
    // takes no `limit`/`page`; that Toggl therefore never truncates the range
    // itself does not follow from that, so `total_received` is named for what
    // it counts — what arrived — and not for the size of the date range.
    has_more: items.length > effectiveLimit,
    limit: effectiveLimit,
    total_received: items.length,
    pagination:
      items.length > effectiveLimit
        ? `Toggl offers no limit or page parameter on this endpoint, so this is a client-side cut of what it sent: the ${effectiveLimit} newest entries were kept and the older ones dropped. To reach the rest, move the window backwards — set end_date at or before the start of the oldest entry above — or raise limit (max 200). Narrowing the window towards today returns the same entries again.`
        : undefined,
  };
}

/** Envelope for a project listing. See {@link timeEntriesEnvelope}. */
export function projectsEnvelope(
  items: unknown[],
  page: number,
  perPage: number,
): Record<string, unknown> {
  return {
    projects: items,
    returned: items.length,
    page,
    per_page: perPage,
    // Named for what it is. Toggl returns no total and no next-page link, so
    // a full page is evidence of more, not proof — calling this `has_more`
    // would assert something this client cannot check.
    possibly_more_pages: items.length >= perPage,
    // Both values are hedged, not just `true`. A short page is the ordinary
    // sign of the last one, but it also looks exactly like Toggl silently
    // capping `per_page` below what was asked for — which would read as
    // "no more projects" while hundreds remained.
    pagination:
      items.length >= perPage
        ? `This is page ${page} at ${perPage} per page, and it came back full. That usually means more remain: call again with page ${page + 1}, or raise per_page (max 200). Toggl returns no total and no next-page link, so the number of pages is unknown.`
        : `This is page ${page} at ${perPage} per page, and it came back short (${items.length}), which usually means it is the last one. Toggl returns no total, so if it capped per_page below ${perPage} rather than running out of projects, more remain — request page ${page + 1} when it matters.`,
  };
}
