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
 * full downstream round trip later. `Book.author` reuses the same gate one
 * level down: `Author.books` needs `book.authorId`, already on the parent row,
 * so the author's books load can start alongside the author load. This module
 * only answers "will that child really be resolved, and is it safe to start
 * it early?"; it never fetches.
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
 * True when every root field the operation will execute is a by-id root
 * (`author(id)`, `book(id)`, aliases included) or `__typename`. Root inline and
 * named fragments are flattened (cycle-guarded) and nodes excluded by
 * `@skip`/`@include` are ignored, because graphql-js `collectFields` merges them
 * into one field map and calls every Query root resolver in the same tick --
 * the same-tick argument rests on that flattened list, not on the spelling.
 * `__typename` runs no resolver or loader, so it cannot split a batch. Any
 * other root -- a list root such as `authors` (even hidden in a root
 * fragment), an introspection root, or an unknown fragment -- could reach the
 * same loader a hop later; an early dispatch would split that batch and cost an
 * extra downstream call, so such operations never prefetch. Only `query`
 * operations qualify: mutation roots execute serially, so the same-tick
 * argument would not hold for them.
 */
function rootsArePrefetchSafe(info: GraphQLResolveInfo): boolean {
  if (info.operation.operation !== 'query') return false;
  const seen = new Set<string>();
  const safe = (set: SelectionSetNode): boolean =>
    set.selections.every((sel) => {
      if (!isIncluded(sel, info.variableValues)) return true;
      if (sel.kind === Kind.FIELD) return sel.name.value === '__typename' || BY_ID_ROOTS.has(sel.name.value);
      if (sel.kind === Kind.INLINE_FRAGMENT) return safe(sel.selectionSet);
      if (seen.has(sel.name.value)) return true;
      seen.add(sel.name.value);
      const fragment = info.fragments[sel.name.value];
      return fragment !== undefined && safe(fragment.selectionSet);
    });
  return safe(info.operation.selectionSet);
}

/**
 * True when `childName` is selected (and not skipped) directly under the
 * current field, looking through inline and named fragments (cycle-guarded),
 * and every executed root field of the operation is a by-id root or
 * `__typename`. `some` over `fieldNodes` covers a merged same-alias pair, where
 * only one copy may select the child.
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
