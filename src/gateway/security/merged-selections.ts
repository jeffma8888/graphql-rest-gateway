import { GraphQLError, Kind } from 'graphql';
import type {
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  SelectionSetNode,
} from 'graphql';
import { buildFragmentMap } from './validation-cache.js';

/**
 * Fixed cap on how many field selections may merge into one response position.
 *
 * WHY: graphql-js's `OverlappingFieldsCanBeMergedRule` compares every pair of
 * selections that share a response key, and recurses into their subselections
 * per pair, so a few hundred identical `book(id:"x"){ id }` selections inside
 * the token cap cost well over 100 ms of synchronous validation, while the
 * executor runs them once. No legitimate query repeats one response key 32
 * times. A fixed constant (like `MAX_TOKENS`), not an option.
 */
export const MAX_MERGED_SELECTIONS = 32;

/** The first over-cap position found: its response-key path and merged count. */
interface Violation {
  path: string[];
  selections: number;
  node: FieldNode;
}

/** Per-document walk state. */
interface Walk {
  fragments: Map<string, FragmentDefinitionNode>;
  max: number;
  /** Stable small ids for field nodes, so a merged node tuple has a string key. */
  ids: Map<FieldNode, number>;
  /**
   * Result per merged-node tuple. WHY: a position's whole subtree depends only
   * on which field nodes merged into it, and a reused fragment yields the same
   * tuples wherever it is spread, so each tuple is walked once and an alias
   * fan-out through fragments stays linear instead of multiplying per level.
   * The key ignores `ancestors`, which a result can depend on only when the
   * document has a fragment cycle (an invalid document, refused by the spec
   * rules anyway), so for every valid document the memo is exact.
   */
  memo: Map<string, Violation | null>;
  /**
   * Fragments expanded at an ancestor position of the one being walked. WHY:
   * this pass runs before the spec rules, so a fragment cycle (rejected later
   * by `NoFragmentCyclesRule`) must not recurse forever here. Only a spread of
   * a fragment that is both on a spread cycle (`cyclic`) and an ancestor is
   * skipped, so an acyclic re-spread at a deeper position (`...AuthorFields`
   * at every nesting level) still counts once per position. Any infinite
   * descent must repeat a cyclic fragment, so this terminates. Inside a cycle
   * the skip can undercount; `NoFragmentCyclesRule` rejects such a document
   * and graphql-js bounds its overlap work per fragment pair.
   */
  ancestors: Set<string>;
  /** Fragments that can reach themselves through spreads. */
  cyclic: Set<string>;
  /** Fragments expanded anywhere so far, so unused ones can be walked on their own. */
  reached: Set<string>;
}

/**
 * Groups the fields of one response position by response key, the way the
 * executor's `collectFields` / `collectSubfields` do: inline fragments are
 * flattened whatever their type condition, and a named fragment is expanded at
 * most once per position (`visited` is shared by every node merged there).
 * `@skip`/`@include` are ignored on purpose: validation compares every
 * selection, so every selection costs.
 */
function collect(
  set: SelectionSetNode,
  groups: Map<string, FieldNode[]>,
  visited: Set<string>,
  walk: Walk,
): void {
  for (const selection of set.selections) {
    if (selection.kind === Kind.FIELD) {
      const key = selection.alias?.value ?? selection.name.value;
      const group = groups.get(key);
      if (group) group.push(selection);
      else groups.set(key, [selection]);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      collect(selection.selectionSet, groups, visited, walk);
    } else {
      const name = selection.name.value;
      const fragment = walk.fragments.get(name);
      if (visited.has(name) || (walk.cyclic.has(name) && walk.ancestors.has(name)) || !fragment) continue;
      visited.add(name);
      walk.reached.add(name);
      collect(fragment.selectionSet, groups, visited, walk);
    }
  }
}

/** Checks the positions under the given selection sets, in pre-order document order. */
function checkPosition(
  sets: readonly SelectionSetNode[],
  walk: Walk,
  visited: Set<string> = new Set(),
): Violation | null {
  const groups = new Map<string, FieldNode[]>();
  for (const set of sets) collect(set, groups, visited, walk);
  for (const name of visited) walk.ancestors.add(name);
  try {
    for (const [key, fields] of groups) {
      if (fields.length > walk.max) return { path: [key], selections: fields.length, node: fields[0]! };
      const below = checkMerged(fields, walk);
      if (below) return { ...below, path: [key, ...below.path] };
    }
    return null;
  } finally {
    for (const name of visited) walk.ancestors.delete(name);
  }
}

/** Walks the children of one position (the union of its nodes' subselections), memoised by node tuple. */
function checkMerged(fields: readonly FieldNode[], walk: Walk): Violation | null {
  const sets = fields.flatMap((f) => (f.selectionSet ? [f.selectionSet] : []));
  if (sets.length === 0) return null;
  const key = fields.map((f) => idOf(f, walk)).join(',');
  const done = walk.memo.get(key);
  if (done !== undefined) return done;
  const result = checkPosition(sets, walk);
  walk.memo.set(key, result);
  return result;
}

function idOf(field: FieldNode, walk: Walk): number {
  let id = walk.ids.get(field);
  if (id === undefined) {
    id = walk.ids.size;
    walk.ids.set(field, id);
  }
  return id;
}

/** The fragment names spread anywhere inside a selection set. */
function spreadsIn(set: SelectionSetNode, out: string[]): string[] {
  for (const selection of set.selections) {
    if (selection.kind !== Kind.FIELD && selection.kind !== Kind.INLINE_FRAGMENT) out.push(selection.name.value);
    else if (selection.selectionSet) spreadsIn(selection.selectionSet, out);
  }
  return out;
}

/**
 * Fragments on a spread cycle (Tarjan's strongly connected components over the
 * fragment-spread graph): those in a component of more than one fragment, or
 * spreading themselves. Linear in the document.
 */
function cyclicFragments(fragments: Map<string, FragmentDefinitionNode>): Set<string> {
  const edges = new Map<string, string[]>();
  for (const [name, def] of fragments) {
    edges.set(name, spreadsIn(def.selectionSet, []).filter((to) => fragments.has(to)));
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cyclic = new Set<string>();
  const connect = (v: string): void => {
    index.set(v, index.size);
    low.set(v, index.get(v)!);
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v)!) {
      if (!index.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) !== index.get(v)) return;
    const component: string[] = [];
    let w: string;
    do {
      w = stack.pop()!;
      onStack.delete(w);
      component.push(w);
    } while (w !== v);
    if (component.length > 1 || edges.get(v)!.includes(v)) for (const c of component) cyclic.add(c);
  };
  for (const name of fragments.keys()) if (!index.has(name)) connect(name);
  return cyclic;
}

/** The single `QUERY_TOO_REPETITIVE` error shape. */
function repetitionError(found: Violation, max: number): GraphQLError {
  const path = found.path.join('.');
  return new GraphQLError(
    `Query repeats a field too often: ${found.selections} selections merge into "${path}", above the maximum of ${max}.`,
    {
      nodes: [found.node],
      extensions: { code: 'QUERY_TOO_REPETITIVE', path, selections: found.selections, maxSelections: max },
    },
  );
}

/**
 * One error per operation in which more than `max` field selections merge
 * into one response position, reporting the first such position in pre-order
 * document order. When no operation is over the cap, every fragment definition
 * no operation reached is walked on its own (paths relative to the fragment
 * root) and the first violation found is one error. WHY: graphql-js's
 * `OverlappingFieldsCanBeMergedRule` visits unused fragments too, and
 * `NoUnusedFragmentsRule` rejects them only within the same validation pass,
 * after that quadratic work is paid. A used fragment needs no separate walk:
 * wherever it is spread, at least its own selections merge. Linear in the
 * document for valid documents; meant to run after depth/complexity and
 * before graphql-js's specified rules.
 */
export function mergedSelectionErrors(doc: DocumentNode, max = MAX_MERGED_SELECTIONS): GraphQLError[] {
  const fragments = buildFragmentMap(doc);
  const walk: Walk = {
    fragments,
    max,
    ids: new Map(),
    memo: new Map(),
    ancestors: new Set(),
    cyclic: cyclicFragments(fragments),
    reached: new Set(),
  };
  const errors: GraphQLError[] = [];
  for (const def of doc.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) continue;
    const found = checkPosition([def.selectionSet], walk);
    if (found) errors.push(repetitionError(found, max));
  }
  if (errors.length > 0) return errors;
  for (const def of doc.definitions) {
    if (def.kind !== Kind.FRAGMENT_DEFINITION) continue;
    // A duplicate name (refused later by `UniqueFragmentNamesRule`) is not the
    // one spreads resolve to, so it is walked without being marked expanded;
    // any other fragment is walked as if spread at a root position (already
    // expanded there), so it counts once.
    const name = def.name.value;
    const shadowed = fragments.get(name) !== def;
    if (!shadowed && walk.reached.has(name)) continue;
    if (!shadowed) walk.reached.add(name);
    const found = checkPosition([def.selectionSet], walk, shadowed ? new Set() : new Set([name]));
    if (found) return [repetitionError(found, max)];
  }
  return errors;
}
