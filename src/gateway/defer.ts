import type { Plugin } from 'graphql-yoga';
import {
  getDirectiveValues,
  getOperationAST,
  getVariableValues,
  GraphQLError,
  Kind,
  visit,
  type DirectiveNode,
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLDirective,
  type SelectionSetNode,
} from 'graphql';

/** The two reply media types that can carry incremental payloads. */
const STREAMING_MEDIA_TYPES = ['multipart/mixed', 'text/event-stream'] as const;

/**
 * Media ranges of the request's `accept` header, parsed the way Yoga's result
 * processor parses them (missing header = `*` / `*`, whitespace dropped,
 * lower-cased, a non-utf-8 charset skips the entry). WHY mirror Yoga rather
 * than RFC 9110 q-values: the guard must refuse exactly the requests Yoga
 * would later answer with an empty 406, no more and no fewer.
 */
function acceptedRanges(request: Request): string[] {
  const ranges: string[] = [];
  const header = (request.headers.get('accept') || '*/*').replace(/\s/g, '').toLowerCase();
  for (const entry of header.split(',')) {
    const [range, ...params] = entry.split(';');
    const charset = params.find((p) => p.includes('charset=')) ?? 'charset=utf-8';
    if (range && charset === 'charset=utf-8') ranges.push(range);
  }
  return ranges;
}

/** Whether `range` (possibly `type/*` or `*` / `*`) covers the concrete `mediaType`. */
function rangeCovers(range: string, mediaType: string): boolean {
  const [type, subtype] = range.split('/');
  const [wantType, wantSubtype] = mediaType.split('/');
  return (type === '*' || type === wantType) && (subtype === '*' || subtype === wantSubtype);
}

/** True when the client can receive a streamed (incremental) reply. */
export function acceptsIncrementalDelivery(request: Request): boolean {
  const ranges = acceptedRanges(request);
  return STREAMING_MEDIA_TYPES.some((type) => ranges.some((range) => rangeCovers(range, type)));
}

// Per parsed document: does it mention `@defer` anywhere? Yoga's parse cache
// hands repeat queries the same DocumentNode, so the common no-defer case
// costs one walk per distinct document, not one per request.
const mentionsDefer = new WeakMap<DocumentNode, boolean>();

function documentMentionsDefer(doc: DocumentNode): boolean {
  let found = mentionsDefer.get(doc);
  if (found === undefined) {
    found = false;
    visit(doc, {
      Directive(node) {
        if (node.name.value === 'defer') found = true;
      },
    });
    mentionsDefer.set(doc, found);
  }
  return found;
}

/**
 * Whether the executed operation has at least one `@defer` that is active for
 * these variables. WHY evaluate `if` (literal or variable) per request: an
 * inactive defer executes as a plain reply, which a JSON client can take, so
 * refusing it would break `@defer(if: $streaming)` clients. Fragment spreads
 * are followed once each, so a shared fragment is not re-walked.
 */
function hasActiveDefer(
  directive: GraphQLDirective,
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  variables: Record<string, unknown>,
  seen: Set<string>,
): boolean {
  const active = (node: { readonly directives?: readonly DirectiveNode[] }): boolean =>
    getDirectiveValues(directive, node, variables)?.['if'] === true;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (selection.selectionSet && hasActiveDefer(directive, selection.selectionSet, fragments, variables, seen)) {
        return true;
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      if (active(selection)) return true;
      if (hasActiveDefer(directive, selection.selectionSet, fragments, variables, seen)) return true;
    } else {
      if (active(selection)) return true;
      const name = selection.name.value;
      const fragment = fragments.get(name);
      if (fragment && !seen.has(name)) {
        seen.add(name);
        if (hasActiveDefer(directive, fragment.selectionSet, fragments, variables, seen)) return true;
      }
    }
  }
  return false;
}

/** The typed refusal: a JSON body with HTTP 406, naming the media types that would work. */
function deferNotAcceptedError(): GraphQLError {
  const types = STREAMING_MEDIA_TYPES.join(' or ');
  return new GraphQLError(`@defer needs a streaming reply: send an accept header that admits ${types}`, {
    extensions: {
      code: 'DEFER_NOT_ACCEPTED',
      http: { status: 406, headers: { accept: STREAMING_MEDIA_TYPES.join(', ') } },
    },
  });
}

/**
 * Refuses an operation with an active `@defer` when the client accepts no
 * streaming media type. WHY before execution: Yoga only picks the result
 * processor after the first payload, so without this guard a JSON-only client
 * gets an empty-body 406 after the gateway has already sent downstream calls.
 * Here the refusal is typed and costs 0 calls. It must run before the
 * extension-stamping plugins, so the refusal carries no extensions -- the same
 * shape as the other admission rejections.
 */
export function deferAcceptPlugin(): Plugin {
  return {
    onExecute({ args, setResultAndStopExecution }) {
      if (!documentMentionsDefer(args.document)) return;
      const directive = args.schema.getDirective('defer');
      const request = (args.contextValue as { request?: Request }).request;
      const op = getOperationAST(args.document, args.operationName);
      if (!directive || !request || !op || acceptsIncrementalDelivery(request)) return;
      const fragments = new Map<string, FragmentDefinitionNode>();
      for (const def of args.document.definitions) {
        if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
      }
      // Coerced like the executor will (defaults applied), so `$d = false`
      // with no value is inactive here too. Uncoercible variables are left to
      // the executor, which reports them as BAD_USER_INPUT.
      const coerced = getVariableValues(args.schema, op.variableDefinitions ?? [], args.variableValues ?? {});
      if (!coerced.coerced) return;
      if (hasActiveDefer(directive, op.selectionSet, fragments, coerced.coerced, new Set())) {
        setResultAndStopExecution({ errors: [deferNotAcceptedError()] });
      }
    },
  };
}
