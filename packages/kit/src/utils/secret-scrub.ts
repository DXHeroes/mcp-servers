/**
 * Keeping a credential the upstream API handed back out of what a package
 * relays.
 *
 * Some APIs put a live credential in an ordinary payload. Toggl's workspace
 * model carries an `api_token` and an `ical_url` — an unauthenticated
 * capability link to the user's calendar — and both were relayed verbatim to
 * the model and into the debug log until the client learned to strip them
 *. The connector host redacts too, but only a fixed set of key names,
 * so a package cannot treat that as its scrubber: the key names its own API
 * uses, and the shape of its own credentials, are its to know.
 *
 * This is opt-in. Nothing scrubs unless a package constructs a
 * {@link SecretScrubber}, and a package that has no secrets in its payloads
 * should not. It lives in the kit so the second package that needs one writes a
 * configuration rather than an algorithm — and so the traps below are solved
 * once: keys are scrubbed as well as values, a secret found in one part of a
 * payload is scrubbed everywhere else in it, and the input is never mutated.
 */

/** Shortest value still scrubbed by value, unless the caller says otherwise. */
const DEFAULT_MIN_SECRET_LENGTH = 8;

/** Stands in for the value of a key that is never relayed. */
const DEFAULT_REDACTED_PLACEHOLDER = '[REDACTED]';

/** Stands in for a secret found *inside* an otherwise ordinary value. */
const DEFAULT_SECRET_PLACEHOLDER = '[REDACTED-SECRET]';

export interface SecretScrubberOptions {
  /**
   * Key name fragments whose value is never relayed, matched as a
   * case-insensitive **substring** rather than by equality.
   *
   * Substring on purpose: the same secret shows up under near-miss names
   * (`ical_urls` on a list payload, `ical_url_secret`, `ICAL_URL` from a
   * differently-cased proxy) and every one of those carries the whole
   * credential. The key survives with its value replaced, because "the field
   * was withheld" and "the API did not return the field" are different facts.
   */
  redactedKeyStems?: readonly string[];

  /**
   * Secrets known before any response arrives — the API token, a derived Basic
   * credential — replaced wherever they occur, including inside free text.
   *
   * Only pass a value that cannot plausibly *be* legitimate data. Replacing a
   * placeholder token like `Marketing` would corrupt every client name in the
   * payload while leaving it syntactically valid, which is worse than not
   * scrubbing: the caller cannot tell. Where a real credential has a
   * recognisable shape, check it before passing it in and say so out loud when
   * it fails the check, rather than degrading silently.
   *
   * Values shorter than {@link SecretScrubberOptions.minSecretLength} are
   * dropped here, so a stub token in a test fixture cannot mangle unrelated
   * text.
   */
  secretValues?: readonly string[];

  /**
   * Patterns for a secret this package cannot know in advance, each with
   * **exactly one capture group** around the secret itself.
   *
   * Two things happen with a match: the captured group is replaced in place
   * (the rest of the match is kept, so `/ical/workspace_user/{secret}` stays
   * recognisable as a redacted calendar link), and the captured value is added
   * to the secrets scrubbed everywhere else in the same payload — a share link
   * pasted into one description reveals the secret that must then be blanked
   * out of the bare string in the next field.
   *
   * The `g` and `d` flags are added if missing; other flags are kept.
   */
  capturePatterns?: readonly RegExp[];

  /** Floor on value-based scrubbing. Defaults to 8 characters. */
  minSecretLength?: number;

  /** Replacement for a redacted key's value. Defaults to `[REDACTED]`. */
  redactedPlaceholder?: string;

  /**
   * Replacement for a secret found inside a value. Defaults to
   * `[REDACTED-SECRET]`, deliberately distinct from the key placeholder:
   * "this string contained a credential" is a different thing to report than
   * "this field is never relayed".
   */
  secretPlaceholder?: string;
}

/**
 * Writes one key of the rebuilt payload, **including a key called
 * `__proto__`**.
 *
 * `result[key] = value` looks like the obvious way to do this and silently
 * loses that one key. `__proto__` is an accessor on `Object.prototype`, so a
 * plain assignment invokes its setter instead of creating an own property: the
 * key never appears in the copy, and an object or `null` value replaces the
 * copy's prototype on the way past. Measured against PostgreSQL 17.11 through
 * the `postgres` package, whose rows are arbitrary user data:
 * `SELECT 1 AS "__proto__", 2 AS ok` came back as `{"ok":2}` while `fields`
 * still announced the column, and
 * `jsonb_build_object('__proto__', jsonb_build_object(...))` lost the nested
 * object whole. `Object.prototype` was never actually polluted — a number
 * value makes the setter a no-op and an object value replaces only this copy's
 * prototype — so the defect is silent data loss, not prototype pollution.
 *
 * `Object.defineProperty` creates an own, enumerable, writable, configurable
 * property whatever the key is called, which is exactly what `JSON.parse`
 * itself does for the same input — so the copy keeps the shape the payload
 * arrived in. The prototype of the copy is deliberately left alone (a plain
 * `{}`, not `Object.create(null)`): callers spread the result, serialise it and
 * hand it to code that expects an ordinary object, and a null-prototype copy
 * would be a much wider change than the one key needs.
 */
function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Adds the flags {@link SecretScrubber} relies on, keeping the rest. */
function withRequiredFlags(pattern: RegExp): RegExp {
  const flags = new Set([...pattern.flags, 'g', 'd']);
  return new RegExp(pattern.source, [...flags].join(''));
}

/**
 * Redacts an upstream payload by key name, by known value, and by shape.
 *
 * Construct one per credential (per client instance, usually) and run every
 * response through it at the single choke point the package's HTTP calls go
 * through — not at individual call sites, which is a list nobody keeps
 * complete.
 *
 * **Order matters.** Whatever else a package does to a payload — dropping
 * duplicate keys, trimming lists, collapsing nulls — must run *after*
 * {@link SecretScrubber.scrub}, never before it. The scrubber has to see the
 * payload the API actually sent; a transformation that ran first can drop or
 * rename the key that carried the credential and hide it from the scrubber,
 * and the result is a credential in the debug log.
 */
export class SecretScrubber {
  private readonly keyStems: readonly string[];
  private readonly knownSecrets: readonly string[];
  private readonly capturePatterns: readonly RegExp[];
  private readonly minSecretLength: number;
  private readonly redactedPlaceholder: string;
  private readonly secretPlaceholder: string;

  constructor(options: SecretScrubberOptions = {}) {
    this.minSecretLength = options.minSecretLength ?? DEFAULT_MIN_SECRET_LENGTH;
    this.keyStems = (options.redactedKeyStems ?? []).map((stem) => stem.toLowerCase());
    this.knownSecrets = (options.secretValues ?? []).filter(
      (value) => value.length >= this.minSecretLength,
    );
    this.capturePatterns = (options.capturePatterns ?? []).map(withRequiredFlags);
    this.redactedPlaceholder = options.redactedPlaceholder ?? DEFAULT_REDACTED_PLACEHOLDER;
    this.secretPlaceholder = options.secretPlaceholder ?? DEFAULT_SECRET_PLACEHOLDER;
  }

  /** Whether a key's value is never relayed. See `redactedKeyStems`. */
  isRedactedKey(key: string): boolean {
    const normalised = key.toLowerCase();
    return this.keyStems.some((stem) => normalised.includes(stem));
  }

  /**
   * Replaces every known secret in a string, plus anything matching a capture
   * pattern.
   *
   * Use it on the one path that hands raw remote text back without parsing it:
   * an error body. `extraSecrets` are scrubbed alongside the configured ones,
   * which is how {@link SecretScrubber.scrub} propagates a secret it found in
   * one field to the rest of the payload.
   */
  scrubText(text: string, extraSecrets: readonly string[] = []): string {
    const secrets =
      extraSecrets.length > 0 ? [...this.knownSecrets, ...extraSecrets] : this.knownSecrets;
    let result = text;
    for (const secret of secrets) {
      if (result.includes(secret)) {
        result = result.split(secret).join(this.secretPlaceholder);
      }
    }
    return this.scrubCaptures(result);
  }

  /**
   * Redacts a JSON-decoded payload of any shape.
   *
   * Returns a copy; the input is never mutated. Primitives and `null` pass
   * through unchanged apart from string scrubbing, so this is safe to apply to
   * every endpoint's payload — which is the point of applying it in one place.
   *
   * A redacted key whose value is `null` keeps its `null`: the API returned no
   * value, so there is nothing to withhold, and reporting `[REDACTED]` there
   * would claim a secret exists where none does.
   *
   * Read the note on the class about running compaction *after* this, not
   * before.
   */
  scrub<T>(value: T): T {
    const found = new Set<string>();
    this.collectPayloadSecrets(value, found);
    return this.scrubValue(value, [...found]);
  }

  /** Replaces the captured group of every capture-pattern match, in place. */
  private scrubCaptures(text: string): string {
    let result = text;
    for (const pattern of this.capturePatterns) {
      let rebuilt = '';
      let cursor = 0;
      let replaced = false;
      for (const match of result.matchAll(pattern)) {
        // A pattern whose group did not participate has nothing to redact, and
        // blanking the whole match instead would delete surrounding context.
        const span = match.indices?.[1];
        if (!span) continue;
        rebuilt += result.slice(cursor, span[0]) + this.secretPlaceholder;
        cursor = span[1];
        replaced = true;
      }
      if (replaced) result = rebuilt + result.slice(cursor);
    }
    return result;
  }

  /**
   * Collects the secrets only this payload reveals, so they can be scrubbed
   * everywhere else in it.
   *
   * Two sources: a capture pattern's group, and the value sitting under a
   * redacted key. Once known, the bare value is scrubbed even where it appears
   * without the key or URL that gave it away.
   */
  private collectPayloadSecrets(value: unknown, found: Set<string>): void {
    if (typeof value === 'string') {
      for (const pattern of this.capturePatterns) {
        for (const match of value.matchAll(pattern)) {
          const secret = match[1];
          if (secret && secret.length >= this.minSecretLength) found.add(secret);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) this.collectPayloadSecrets(item, found);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (
          this.isRedactedKey(key) &&
          typeof nested === 'string' &&
          nested.length >= this.minSecretLength
        ) {
          found.add(nested);
        }
        this.collectPayloadSecrets(nested, found);
      }
    }
  }

  private scrubValue<T>(value: T, extraSecrets: readonly string[]): T {
    if (typeof value === 'string') {
      return this.scrubText(value, extraSecrets) as unknown as T;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.scrubValue(item, extraSecrets)) as unknown as T;
    }
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        // Key names are scrubbed as well: a payload (or a proxy echoing one)
        // can put a credential in the key rather than the value.
        const safeKey = this.scrubText(key, extraSecrets);
        if (this.isRedactedKey(key)) {
          defineOwn(result, safeKey, nested === null ? null : this.redactedPlaceholder);
          continue;
        }
        defineOwn(result, safeKey, this.scrubValue(nested, extraSecrets));
      }
      return result as T;
    }
    return value;
  }
}
