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
 * Root fields whose child edge key is `args.id`, so their prefetch is known in tick 0.
 * Keep in sync with the Query resolvers that call `willResolveChild` (resolvers.ts).
 */
const BY_ID_ROOTS = new Set(['author', 'book']);

/**
 * True when every root selection is a by-id root FIELD node (`author(id)`,
 * `book(id)`, aliases included). graphql-js calls all Query root resolvers in
 * the same tick, so those roots' prefetches coalesce into one batch per loader.
 * Any other root -- a list root, a root `__typename`, or a root-level fragment,
 * which may hide either -- could reach the same loader a hop later; an early
 * dispatch would split that batch and cost an extra downstream call, so such
 * operations never prefetch. Only `query` operations qualify: mutation roots
 * execute serially, so the same-tick argument would not hold for them.
 */
function rootsArePrefetchSafe(info: GraphQLResolveInfo): boolean {
  if (info.operation.operation !== 'query') return false;
  return info.operation.selectionSet.selections.every(
    (sel) => sel.kind === Kind.FIELD && BY_ID_ROOTS.has(sel.name.value),
  );
}

/**
 * True when `childName` is selected (and not skipped) directly under the
 * current field, looking through inline and named fragments (cycle-guarded),
 * and every root selection of the operation is a by-id root field. `some` over
 * `fieldNodes` covers a merged same-alias pair, where only one copy may select
 * the child.
 */
export function willResolveChild(info: GraphQLResolveInfo, childName: string): boolean {
  if (!rootsArePrefetchSafe(info)) return false;
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
  return info.fieldNodes.some((node) => walk(node.selectionSet));
}
