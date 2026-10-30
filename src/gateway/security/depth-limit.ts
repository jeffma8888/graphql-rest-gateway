import { GraphQLError, Kind } from 'graphql';
import type { ValidationRule, SelectionSetNode, FragmentDefinitionNode } from 'graphql';
import { buildFragmentMap, getValidationResult, setValidationResult } from './validation-cache.js';

/**
 * Query depth-limiting validation rule.
 *
 * Nested graphs make it trivial to write an exponentially expensive query
 * (`author { books { author { books { ... } } } }`). This rejects any operation
 * whose field-nesting exceeds `maxDepth` BEFORE execution starts -- a basic but
 * essential DoS control most demos skip. Fragment spreads are followed;
 * introspection meta-fields (`__schema`, `__type`) are ignored so GraphiQL works.
 */

function selectionSetDepth(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  visited: Set<string>,
): number {
  let max = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (selection.name.value.startsWith('__')) continue;
      const childDepth = selection.selectionSet
        ? selectionSetDepth(selection.selectionSet, fragments, visited)
        : 0;
      max = Math.max(max, 1 + childDepth);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      max = Math.max(max, selectionSetDepth(selection.selectionSet, fragments, visited));
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const name = selection.name.value;
      if (visited.has(name)) continue; // guard against cyclic fragments
      const fragment = fragments.get(name);
      if (!fragment) continue;
      visited.add(name);
      max = Math.max(max, selectionSetDepth(fragment.selectionSet, fragments, visited));
      visited.delete(name);
    }
  }
  return max;
}

/** Exported for unit tests / tooling: compute the depth without a limit. */
export function measureDepth(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
): number {
  return selectionSetDepth(selectionSet, fragments, new Set());
}

export function depthLimit(maxDepth: number): ValidationRule {
  return (context) => {
    const doc = context.getDocument();
    const fragments = buildFragmentMap(doc);
    return {
      OperationDefinition(node) {
        const depth = selectionSetDepth(node.selectionSet, fragments, new Set());
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
