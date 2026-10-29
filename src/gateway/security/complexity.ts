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
} from 'graphql';
import type {
  ValidationRule,
  SelectionSetNode,
  FragmentDefinitionNode,
  FieldNode,
  OperationDefinitionNode,
} from 'graphql';
import { getValidationResult, setValidationResult, buildFragmentMap } from './validation-cache';

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

function costOfSelectionSet(
  selectionSet: SelectionSetNode,
  parentType: GraphQLNamedType | undefined | null,
  cc: CostContext,
  visited: Set<string>,
): number {
  const fields =
    parentType && (isObjectType(parentType) || isInterfaceType(parentType))
      ? parentType.getFields()
      : {};

  let cost = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (selection.name.value.startsWith('__')) continue;
      const fieldDef = fields[selection.name.value];
      const namedChildType = fieldDef ? getNamedType(fieldDef.type) : undefined;
      const childCost = selection.selectionSet
        ? costOfSelectionSet(selection.selectionSet, namedChildType, cc, visited)
        : 0;

      let multiplier = 1;
      if (fieldDef && !RELAY_WRAPPER_FIELDS.has(selection.name.value)) {
        const first = intArg(selection, 'first', cc) ?? intArg(selection, 'last', cc);
        if (first !== undefined) multiplier = first;
        else if (isListDeep(fieldDef.type)) multiplier = cc.defaultListSize;
      }
      cost += 1 + multiplier * childCost;
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      const typeName = selection.typeCondition?.name.value;
      const target = typeName ? cc.getType(typeName) : parentType;
      cost += costOfSelectionSet(selection.selectionSet, target, cc, visited);
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const name = selection.name.value;
      if (visited.has(name)) continue;
      const fragment = cc.fragments.get(name);
      if (!fragment) continue;
      const target = cc.getType(fragment.typeCondition.name.value);
      visited.add(name);
      cost += costOfSelectionSet(fragment.selectionSet, target, cc, visited);
      visited.delete(name);
    }
  }
  return cost;
}

export function complexityLimit(maxComplexity: number, defaultListSize = 5): ValidationRule {
  return (context) => {
    const doc = context.getDocument();
    const schema = context.getSchema();
    const cached = getValidationResult(doc);
    const fragments = cached?.fragments ?? buildFragmentMap(doc);
    const getType = (name: string): GraphQLNamedType | undefined => schema.getType(name) ?? undefined;
    const operationCount = doc.definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION).length;

    return {
      OperationDefinition(node) {
        const cc: CostContext = { getType, fragments, defaultListSize, usesVariables: false };
        const rootType =
          node.operation === 'query'
            ? schema.getQueryType()
            : node.operation === 'mutation'
              ? schema.getMutationType()
              : schema.getSubscriptionType();
        const staticCost = costOfSelectionSet(node.selectionSet, rootType, cc, new Set());
        // WHY -1: the WeakMap entry is per *document* and shared by every
        // request that sends it, so a variable-dependent cost must never be
        // cached; nor may one operation's cost stand in for a sibling's in a
        // multi-operation document. The sentinel makes the execute phase
        // recompute (and enforce) for the operation actually run.
        const cost = cc.usesVariables || operationCount > 1 ? -1 : staticCost;
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

/**
 * Computes the cost without a limit (execute phase, tooling, unit tests).
 * Pass `resolveVariable` to count variable-supplied `first`/`last` with their
 * runtime values; without it they count as omitted arguments.
 */
export function estimateComplexity(
  selectionSet: SelectionSetNode,
  parentType: GraphQLNamedType | undefined | null,
  getType: (name: string) => GraphQLNamedType | undefined,
  fragments: Map<string, FragmentDefinitionNode>,
  defaultListSize = 5,
  resolveVariable?: VariableResolver,
): number {
  const cc: CostContext = { getType, fragments, defaultListSize, resolveVariable, usesVariables: false };
  return costOfSelectionSet(selectionSet, parentType, cc, new Set());
}
