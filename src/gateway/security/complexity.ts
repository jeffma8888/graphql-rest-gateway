import {
  GraphQLError,
  Kind,
  getNamedType,
  isListType,
  isNonNullType,
  isObjectType,
  isInterfaceType,
  type GraphQLType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLSchema,
} from 'graphql';
import type {
  ValidationRule,
  SelectionSetNode,
  FragmentDefinitionNode,
  FieldNode,
  OperationDefinitionNode,
} from 'graphql';
import { getValidationResult, setValidationResult, buildFragmentMap } from './validation-cache.js';

/**
 * Query complexity (cost) validation rule.
 *
 * Depth alone doesn't catch a shallow-but-wide query (`authors(first: 10000)`).
 * This estimates a static worst-case node count: each field costs 1, and a
 * list-returning field multiplies its subtree by an estimated fan-out --
 * `first`/`last` when present, else `defaultListSize`. Relay wrappers
 * (`edges`, `nodes`, `pageInfo`) get a multiplier of 1 because they're already
 * bounded by the parent connection's `first`, which avoids double-counting.
 *
 * It's a conservative upper bound, not an exact runtime cost -- which is
 * exactly what you want for an admission-control limit.
 *
 * `first`/`last` passed as GraphQL variables can't be known during validation
 * (validation rules never see variable values). So the validation rule only
 * enforces variable-free operations; for variable-dependent ones it defers to
 * the execute phase (`complexityError` + `variableResolver`), which re-runs
 * the estimate with the request's real values before any resolver runs.
 */

const RELAY_WRAPPER_FIELDS = new Set(['edges', 'nodes', 'pageInfo']);

function isListDeep(type: GraphQLType): boolean {
  if (isNonNullType(type)) return isListDeep(type.ofType);
  return isListType(type);
}

/** Resolves a variable name to its runtime integer, or `undefined` if unknown/null. */
export type VariableResolver = (name: string) => number | undefined;

/**
 * Reads an integer fan-out argument. Clamped at 0 so a negative `first`
 * (literal or variable) can never drive the summed cost negative -- otherwise
 * one `first: -1000` alias would "pay for" an arbitrarily expensive sibling.
 */
function intArg(field: FieldNode, name: string, cc: CostContext): number | undefined {
  const value = field.arguments?.find((a) => a.name.value === name)?.value;
  let n: number | undefined;
  if (value?.kind === Kind.INT) {
    n = Number.parseInt(value.value, 10);
  } else if (value?.kind === Kind.VARIABLE) {
    cc.usesVariables = true;
    n = cc.resolveVariable?.(value.name.value);
  }
  return n === undefined ? undefined : Math.max(0, n);
}

interface CostContext {
  getType(name: string): GraphQLNamedType | undefined;
  fragments: Map<string, FragmentDefinitionNode>;
  defaultListSize: number;
  /** Absent during validation (variables unknown); present at execute time. */
  resolveVariable?: VariableResolver;
  /** Set when a fan-out argument references a variable, i.e. cost is per-request. */
  usesVariables: boolean;
  /** Finished fragments' results, by name, for this walk only. */
  memo: Map<string, Measure>;
  /** Fragments currently being walked, so a cyclic spread terminates. */
  inProgress: Set<string>;
}

/**
 * Builds a resolver over a request's raw variable values, falling back to the
 * operation's declared default when the variable is not supplied at all. An
 * explicit `null` stays null (GraphQL semantics) and counts as an omitted arg.
 */
export function variableResolver(
  op: OperationDefinitionNode,
  variableValues: Readonly<Record<string, unknown>> | null | undefined,
): VariableResolver {
  return (name) => {
    const vars = variableValues ?? {};
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      const v = vars[name];
      return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
    }
    const def = op.variableDefinitions?.find((d) => d.variable.name.value === name)?.defaultValue;
    return def?.kind === Kind.INT ? Number.parseInt(def.value, 10) : undefined;
  };
}

/** The single `QUERY_TOO_COMPLEX` error shape, shared by the validation and execute phases. */
export function complexityError(
  cost: number,
  maxComplexity: number,
  node: OperationDefinitionNode,
): GraphQLError {
  return new GraphQLError(
    `Query is too complex: cost ${cost} exceeds the maximum of ${maxComplexity}.`,
    { nodes: [node], extensions: { code: 'QUERY_TOO_COMPLEX', cost, maxComplexity } },
  );
}

/** The two numbers one walk yields: estimated cost and field-nesting depth. */
export interface Measure {
  cost: number;
  depth: number;
}

/**
 * Walks one selection set, returning cost and depth together. WHY one walk
 * with a per-walk memo: a fragment's result depends only on its own body and
 * type condition (never on where it is spread), so each named fragment is
 * walked at most once and repeat spreads reuse the result. Without the memo a
 * cap-respecting chain `fragment Fi { ...F(i+1) ...F(i+1) }` costs 2^n visits.
 * Repeats still ADD their cost; only the walking is shared. A fragment still
 * being walked (a cycle, which spec rules reject later) counts as {0, 0}.
 */
function measureSelectionSet(
  selectionSet: SelectionSetNode,
  parentType: GraphQLNamedType | undefined | null,
  cc: CostContext,
): Measure {
  const fields =
    parentType && (isObjectType(parentType) || isInterfaceType(parentType))
      ? parentType.getFields()
      : {};

  let cost = 0;
  let depth = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (selection.name.value.startsWith('__')) continue;
      const fieldDef = fields[selection.name.value];
      const namedChildType = fieldDef ? getNamedType(fieldDef.type) : undefined;
      const child = selection.selectionSet
        ? measureSelectionSet(selection.selectionSet, namedChildType, cc)
        : { cost: 0, depth: 0 };

      let multiplier = 1;
      if (fieldDef && !RELAY_WRAPPER_FIELDS.has(selection.name.value)) {
        const first = intArg(selection, 'first', cc) ?? intArg(selection, 'last', cc);
        if (first !== undefined) multiplier = first;
        else if (isListDeep(fieldDef.type)) multiplier = cc.defaultListSize;
      }
      cost += 1 + multiplier * child.cost;
      depth = Math.max(depth, 1 + child.depth);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      const typeName = selection.typeCondition?.name.value;
      const target = typeName ? cc.getType(typeName) : parentType;
      const child = measureSelectionSet(selection.selectionSet, target, cc);
      cost += child.cost;
      depth = Math.max(depth, child.depth);
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const child = measureFragment(selection.name.value, cc);
      cost += child.cost;
      depth = Math.max(depth, child.depth);
    }
  }
  return { cost, depth };
}

/** Memoised by name for the duration of one walk; see `measureSelectionSet`. */
function measureFragment(name: string, cc: CostContext): Measure {
  const done = cc.memo.get(name);
  if (done) return done;
  const fragment = cc.fragments.get(name);
  if (!fragment || cc.inProgress.has(name)) return { cost: 0, depth: 0 };
  cc.inProgress.add(name);
  const target = cc.getType(fragment.typeCondition.name.value);
  const result = measureSelectionSet(fragment.selectionSet, target, cc);
  cc.inProgress.delete(name);
  cc.memo.set(name, result);
  return result;
}

/** The root type an operation's selection set is costed against. */
function rootTypeOf(schema: GraphQLSchema, op: OperationDefinitionNode): GraphQLObjectType | null | undefined {
  if (op.operation === 'query') return schema.getQueryType();
  return op.operation === 'mutation' ? schema.getMutationType() : schema.getSubscriptionType();
}

/**
 * Measures one operation (validation rules, execute phase, unit tests).
 * Pass `resolveVariable` to count variable-supplied `first`/`last` with their
 * runtime values; without them they count as omitted arguments.
 * `usesVariables` reports whether the cost depends on a request's variables.
 */
export function measureOperation(
  schema: GraphQLSchema,
  op: OperationDefinitionNode,
  fragments: Map<string, FragmentDefinitionNode>,
  defaultListSize = 5,
  resolveVariable?: VariableResolver,
): Measure & { usesVariables: boolean } {
  const cc: CostContext = {
    getType: (name) => schema.getType(name) ?? undefined,
    fragments,
    defaultListSize,
    resolveVariable,
    usesVariables: false,
    memo: new Map(),
    inProgress: new Set(),
  };
  const { cost, depth } = measureSelectionSet(op.selectionSet, rootTypeOf(schema, op), cc);
  return { cost, depth, usesVariables: cc.usesVariables };
}

export function complexityLimit(maxComplexity: number, defaultListSize = 5): ValidationRule {
  return (context) => {
    const doc = context.getDocument();
    const schema = context.getSchema();
    const cached = getValidationResult(doc);
    const fragments = cached?.fragments ?? buildFragmentMap(doc);
    const operationCount = doc.definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION).length;

    return {
      OperationDefinition(node) {
        const measured = measureOperation(schema, node, fragments, defaultListSize);
        // WHY -1: the WeakMap entry is per *document* and shared by every
        // request that sends it, so a variable-dependent cost must never be
        // cached; nor may one operation's cost stand in for a sibling's in a
        // multi-operation document. The sentinel makes the execute phase
        // recompute (and enforce) for the operation actually run.
        const cost = measured.usesVariables || operationCount > 1 ? -1 : measured.cost;
        if (cached) {
          cached.cost = cost;
        } else {
          setValidationResult(doc, { cost, depth: -1, fragments });
        }
        if (cost > maxComplexity) {
          context.reportError(complexityError(cost, maxComplexity, node));
        }
      },
    };
  };
}
