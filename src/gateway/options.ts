import type { GatewayOptions } from './server.js';

/**
 * Boot-time validation of the library options object. WHY it exists: the CLI
 * validates every env var strictly, but a library caller wiring the gateway
 * from a spread, JSON-loaded or plain-JS config bypasses TypeScript's excess
 * property check. Before this, `maxComplexity: NaN` silently disabled the edge
 * limit, a typo key (`maxComplexty`) was ignored, and `{}` targeted a
 * hard-coded backend. A bad value now throws synchronously from
 * `createGateway`, before anything is built or any downstream call is made.
 *
 * `maxDownstreamCalls`, `maxBatchSize` and `forwardHeaders` keep their own
 * existing validators (and messages); this module adds only the rest.
 */

/**
 * The single source of truth for which keys `createGateway` accepts. A
 * `Record` over `keyof GatewayOptions` makes tsc fail if a field is added to
 * (or removed from) the interface without updating this list.
 */
const KNOWN_KEY_SET: Record<keyof GatewayOptions, true> = {
  restBaseUrl: true,
  maxDepth: true,
  maxComplexity: true,
  loaderOptions: true,
  downstreamTimeoutMs: true,
  maxDownstreamCalls: true,
  forwardHeaders: true,
  maxBatchSize: true,
};
const KNOWN_KEYS: readonly string[] = Object.keys(KNOWN_KEY_SET);

/**
 * Largest delay `setTimeout`/`AbortSignal.timeout` honour. Anything above it
 * is clamped to 1 ms by Node, so every downstream call would "time out" at once.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Edit distance at or under which an unknown key is assumed to be a typo. */
const MAX_TYPO_DISTANCE = 2;
/** Shared leading characters that still count as "meant this key" (`loaders` → `loaderOptions`). */
const HINT_PREFIX_LENGTH = 6;

/** Levenshtein distance, single-row DP: option keys are short, so this is trivially cheap. */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      const substitution = diagonal + (a[i - 1] === b[j - 1] ? 0 : 1);
      row[j] = Math.min(above + 1, row[j - 1]! + 1, substitution);
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/**
 * The known key the caller most likely meant: the closest case-insensitive
 * match within {@link MAX_TYPO_DISTANCE}, else one sharing the first
 * {@link HINT_PREFIX_LENGTH} characters. Undefined when nothing is close, so
 * an unrelated key (`foo`) never gets a misleading hint.
 */
export function suggestKey(unknownKey: string): string | undefined {
  const lower = unknownKey.toLowerCase();
  let best: string | undefined;
  let bestDistance = MAX_TYPO_DISTANCE + 1;
  for (const known of KNOWN_KEYS) {
    const distance = editDistance(lower, known.toLowerCase());
    if (distance < bestDistance) {
      best = known;
      bestDistance = distance;
    }
  }
  if (best !== undefined || lower.length < HINT_PREFIX_LENGTH) return best;
  const prefix = lower.slice(0, HINT_PREFIX_LENGTH);
  return KNOWN_KEYS.find((known) => known.toLowerCase().startsWith(prefix));
}

/**
 * Strings are quoted so `"10"` is visibly not the number 10; objects are shown
 * as JSON. A value JSON cannot encode (a cycle) must not replace the real error.
 */
function describe(value: unknown): string {
  if (typeof value !== 'string' && (typeof value !== 'object' || value === null)) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function assertObject(opts: unknown): asserts opts is Record<string, unknown> {
  if (typeof opts !== 'object' || opts === null) {
    throw new TypeError(`createGateway options must be an object, got ${describe(opts)}`);
  }
}

/** Checked even for `undefined` values: a typo'd key is a typo whatever it holds. */
function assertKnownKeys(opts: Record<string, unknown>): void {
  for (const key of Object.keys(opts)) {
    if (KNOWN_KEYS.includes(key)) continue;
    const hint = suggestKey(key);
    throw new TypeError(`Unknown createGateway option ${JSON.stringify(key)}${hint ? ` (did you mean ${hint}?)` : ''}`);
  }
}

/**
 * Required, and only http(s): `localhost:4001` parses with protocol
 * `localhost:`. A query string or fragment stays accepted (and ignored) here,
 * as the README documents; only the CLI rejects it.
 */
function assertRestBaseUrl(value: unknown): void {
  const protocol = typeof value === 'string' && URL.canParse(value) ? new URL(value).protocol : undefined;
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new TypeError(`restBaseUrl must be an absolute http(s) URL, got ${describe(value)}`);
  }
}

/** Omitted means default; `NaN`/`Infinity`/`0`/`2.5`/`"10"`/`null` are all rejected. */
function assertPositiveInt(key: string, value: unknown, max: number = Number.MAX_SAFE_INTEGER): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    const bound = max < Number.MAX_SAFE_INTEGER ? ` <= ${max}` : '';
    throw new RangeError(`${key} must be a positive integer${bound}, got ${describe(value)}`);
  }
}

/** Both flags are required booleans: a partial object would mix batched and naive behaviour by accident. */
function assertLoaderOptions(value: unknown): void {
  if (value === undefined) return;
  const ok =
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).batch === 'boolean' &&
    typeof (value as Record<string, unknown>).cache === 'boolean';
  if (!ok) {
    throw new TypeError(`loaderOptions must be { batch: boolean, cache: boolean } (BATCHED or NAIVE), got ${describe(value)}`);
  }
}

/** Throws `TypeError`/`RangeError` naming the offending key; called first thing in `createGateway`. */
export function validateGatewayOptions(opts: unknown): asserts opts is GatewayOptions {
  assertObject(opts);
  assertKnownKeys(opts);
  assertRestBaseUrl(opts.restBaseUrl);
  assertPositiveInt('maxDepth', opts.maxDepth);
  assertPositiveInt('maxComplexity', opts.maxComplexity);
  assertPositiveInt('downstreamTimeoutMs', opts.downstreamTimeoutMs, MAX_TIMEOUT_MS);
  assertLoaderOptions(opts.loaderOptions);
}
