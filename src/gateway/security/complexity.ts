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
import type { ValidationRule, SelectionSetNode, FragmentDefinitionNode, FieldNode } from 'graphql';

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
 */

const RELAY_WRAPPER_FIELDS = new Set(['edges', 'nodes', 'pageInfo']);

function isListDeep(type: GraphQLType): boolean {
  if (isNonNullType(type)) return isListDeep(type.ofType);
  return isListType(type);
}

function intArg(field: FieldNode, name: string): number | undefined {
  const arg = field.arguments?.find((a) => a.name.value === name);
  if (arg?.value.kind === Kind.INT) return Number.parseInt(arg.value.value, 10);
  return undefined;
}

interface CostContext {
  getType(name: string): GraphQLNamedType | undefined;
  fragments: Map<string, FragmentDefinitionNode>;
  defaultListSize: number;
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
        const first = intArg(selection, 'first') ?? intArg(selection, 'last');
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
    const schema = context.getSchema();
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const def of context.getDocument().definitions) {
      if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
    }
    const cc: CostContext = {
      getType: (name) => schema.getType(name) ?? undefined,
      fragments,
      defaultListSize,
    };

    return {
      OperationDefinition(node) {
        const rootType =
          node.operation === 'query'
            ? schema.getQueryType()
            : node.operation === 'mutation'
              ? schema.getMutationType()
              : schema.getSubscriptionType();
        const cost = costOfSelectionSet(node.selectionSet, rootType, cc, new Set());
        if (cost > maxComplexity) {
          context.reportError(
            new GraphQLError(
              `Query is too complex: cost ${cost} exceeds the maximum of ${maxComplexity}.`,
              { nodes: [node], extensions: { code: 'QUERY_TOO_COMPLEX', cost, maxComplexity } },
            ),
          );
        }
      },
    };
  };
}

/** Exported for unit tests / tooling: compute the cost without a limit. */
export function estimateComplexity(
  selectionSet: SelectionSetNode,
  parentType: GraphQLNamedType | undefined | null,
  getType: (name: string) => GraphQLNamedType | undefined,
  fragments: Map<string, FragmentDefinitionNode>,
  defaultListSize = 5,
): number {
  return costOfSelectionSet(selectionSet, parentType, { getType, fragments, defaultListSize }, new Set());
}
