import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defaultFieldResolver, getDirectiveValues, isObjectType, type GraphQLSchema } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { requireAuth, requireScope, type GatewayContext } from './context.js';
import { resolvers } from './resolvers.js';

const SDL_FILE = 'schema.graphql';

/**
 * Find the SDL by walking up from this module to the nearest directory holding
 * `schema.graphql`. WHY walk instead of a fixed `../..`: the module runs from
 * two layouts -- `src/gateway/` in the repo (tsx/vitest) and
 * `dist/src/gateway/` in the built package, where the SDL ships at the package
 * root, three levels up. The walk stops at the package root (the first
 * directory with a `package.json`) so a missing SDL fails loudly instead of
 * silently binding the resolvers to some unrelated `schema.graphql` belonging
 * to the consumer's project further up the tree.
 */
function findSdlPath(startDir: string): string {
  for (let dir = startDir; ; dir = dirname(dir)) {
    const candidate = join(dir, SDL_FILE);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, 'package.json'))) {
      throw new Error(`${SDL_FILE} not found between ${startDir} and the package root ${dir}`);
    }
    if (dirname(dir) === dir) {
      throw new Error(`${SDL_FILE} not found between ${startDir} and the filesystem root ${dir}`);
    }
  }
}

/**
 * Schema-first assembly: read the SDL (the source of truth) and bind the
 * resolvers to it.
 */
export const typeDefs = readFileSync(findSdlPath(dirname(fileURLToPath(import.meta.url))), 'utf8');

/**
 * Enforce `@requiresScope(scope: ...)` wherever the SDL puts it: each annotated
 * field's resolver is wrapped so `requireAuth` then `requireScope` run before
 * it. WHY wrap at schema build instead of calling a guard in each resolver: the
 * SDL stays the single contract, so a new mutation is gated by its annotation
 * alone and no resolver can forget the check. WHY before the resolver: the
 * resolver's argument checks and downstream call never run for a refused
 * caller, so a refusal costs 0 downstream calls and reveals nothing about the
 * arguments. Covers every object type, not just Mutation, so the directive is
 * never a silent no-op wherever it is placed.
 */
function applyScopeGates(built: GraphQLSchema): GraphQLSchema {
  const directive = built.getDirective('requiresScope');
  if (!directive) return built;
  for (const type of Object.values(built.getTypeMap())) {
    if (!isObjectType(type) || type.name.startsWith('__')) continue;
    for (const field of Object.values(type.getFields())) {
      const scope: unknown = field.astNode ? getDirectiveValues(directive, field.astNode)?.['scope'] : undefined;
      if (typeof scope !== 'string') continue;
      const resolve = field.resolve ?? defaultFieldResolver;
      field.resolve = (parent, args, ctx: GatewayContext, info) => {
        requireScope(requireAuth(ctx), scope);
        return resolve(parent, args, ctx, info);
      };
    }
  }
  return built;
}

export const schema = applyScopeGates(makeExecutableSchema({ typeDefs, resolvers }));
