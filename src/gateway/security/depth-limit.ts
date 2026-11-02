import { GraphQLError } from 'graphql';
import type { ValidationRule } from 'graphql';
import { buildFragmentMap, getValidationResult, setValidationResult } from './validation-cache.js';
import { measureOperation } from './complexity.js';

/**
 * Query depth-limiting validation rule.
 *
 * Nested graphs make it trivial to write an exponentially expensive query
 * (`author { books { author { books { ... } } } }`). This rejects any operation
 * whose field-nesting exceeds `maxDepth` BEFORE execution starts -- a basic but
 * essential DoS control most demos skip. Fragment spreads are followed;
 * introspection meta-fields (`__schema`, `__type`) are ignored so GraphiQL works.
 * The depth comes from the same fragment-memoised walk as the cost
 * (`measureOperation`), so there is one fragment-following walker to keep safe.
 */

export function depthLimit(maxDepth: number): ValidationRule {
  return (context) => {
    const doc = context.getDocument();
    const schema = context.getSchema();
    const fragments = buildFragmentMap(doc);
    return {
      OperationDefinition(node) {
        // The default list size is fine here: depth never depends on it, only cost does.
        const { depth } = measureOperation(schema, node, fragments);
        const existing = getValidationResult(doc);
        if (existing) {
          existing.depth = depth;
        } else {
          setValidationResult(doc, { cost: -1, depth, fragments });
        }
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(
              `Query is too deep: depth ${depth} exceeds the maximum of ${maxDepth}.`,
              { nodes: [node], extensions: { code: 'QUERY_TOO_DEEP', depth, maxDepth } },
            ),
          );
        }
      },
    };
  };
}
