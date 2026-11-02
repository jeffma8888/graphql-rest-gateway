import { GraphQLError, parse } from 'graphql';
import type { DocumentNode, ParseOptions, Source } from 'graphql';

/**
 * Fixed parser token cap.
 *
 * WHY: graphql-js validation is super-linear in some document shapes
 * (`OverlappingFieldsCanBeMergedRule` is quadratic in repeated same-name
 * fields), and it runs synchronously, so one 40 KB document can block the
 * event loop -- and every concurrent caller -- for seconds. Bounding the token
 * count at parse time bounds all later work. 2000 sits well above any
 * legitimate query this schema serves (the 100-alias budget example is about
 * 1 400 tokens). Comments and whitespace are not tokens, so they never count.
 */
export const MAX_TOKENS = 2000;

/**
 * graphql-js 16 reports the cap as "Document contains more that N tokens"
 * (sic). Accept the corrected spelling too, so a graphql upgrade that fixes
 * the typo does not silently downgrade the typed error to a parse failure.
 * Anchored on the full prefix: graphql-js echoes offending token text in
 * other syntax errors, so an unanchored match would misclassify them.
 */
const TOKEN_LIMIT_MESSAGE = /^Syntax Error: Document contains more th(?:at|an) \d+ tokens\./;

/** The typed refusal clients see instead of graphql-js's raw syntax error. */
function tooLargeError(maxTokens: number): GraphQLError {
  return new GraphQLError(`Query is too large: the document has more than ${maxTokens} tokens.`, {
    extensions: { code: 'QUERY_TOO_LARGE', maxTokens },
  });
}

/**
 * `parse` with the token cap applied. Only the cap's own syntax error is
 * mapped to `QUERY_TOO_LARGE`; every other syntax error passes through
 * unchanged so it still surfaces as `GRAPHQL_PARSE_FAILED`.
 */
export function parseWithTokenLimit(source: string | Source, options?: ParseOptions): DocumentNode {
  try {
    return parse(source, { ...options, maxTokens: MAX_TOKENS });
  } catch (error) {
    if (error instanceof GraphQLError && TOKEN_LIMIT_MESSAGE.test(error.message)) {
      throw tooLargeError(MAX_TOKENS);
    }
    throw error;
  }
}
