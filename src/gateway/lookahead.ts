import {
  GraphQLIncludeDirective,
  GraphQLSkipDirective,
  Kind,
  getDirectiveValues,
  type FieldNode,
  type FragmentSpreadNode,
  type GraphQLResolveInfo,
  type InlineFragmentNode,
  type SelectionSetNode,
} from 'graphql';

/**
 * Lookahead for speculative child prefetch.
 *
 * WHY: on a by-id root (`author(id)`, `book(id)`) the key the child edge needs
 * (`author.id`, `book.id`) is already known from `args.id`, so the child's
 * batched load can start in the same tick as the root fetch instead of one
 * full downstream round trip later. This module only answers "will that child
 * really be resolved, and is it safe to start it early?"; it never fetches.
 */

/** Mirrors graphql-js execution: a node runs unless @skip(if:true) or @include(if:false). */
function isIncluded(
  node: FieldNode | InlineFragmentNode | FragmentSpreadNode,
  variables: GraphQLResolveInfo['variableValues'],
): boolean {
  if (getDirectiveValues(GraphQLSkipDirective, node, variables)?.['if'] === true) return false;
  return getDirectiveValues(GraphQLIncludeDirective, node, variables)?.['if'] !== false;
}

/**
 * True when the operation's root selection set is exactly one FIELD node.
 * A sibling root (or a root-level fragment, which may hide several) could reach
 * the same loader later in the tick; an early dispatch would split its batch
 * and cost extra downstream calls, so those operations never prefetch.
 */
function isSoleRootField(info: GraphQLResolveInfo): boolean {
  const roots = info.operation.selectionSet.selections;
  return roots.length === 1 && roots[0]?.kind === Kind.FIELD;
}

/**
 * True when `childName` is selected (and not skipped) directly under the
 * current field, looking through inline and named fragments (cycle-guarded),
 * and the current field is the operation's sole root field.
 */
export function willResolveChild(info: GraphQLResolveInfo, childName: string): boolean {
  if (!isSoleRootField(info)) return false;
  const seen = new Set<string>();
  const walk = (set: SelectionSetNode | undefined): boolean => {
    if (!set) return false;
    return set.selections.some((sel) => {
      if (!isIncluded(sel, info.variableValues)) return false;
      if (sel.kind === Kind.FIELD) return sel.name.value === childName;
      if (sel.kind === Kind.INLINE_FRAGMENT) return walk(sel.selectionSet);
      if (seen.has(sel.name.value)) return false;
      seen.add(sel.name.value);
      return walk(info.fragments[sel.name.value]?.selectionSet);
    });
  };
  // isSoleRootField guarantees a single root FieldNode, so fieldNodes has length 1 here.
  return info.fieldNodes.some((node) => walk(node.selectionSet));
}
