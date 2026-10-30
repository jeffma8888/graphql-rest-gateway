import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeExecutableSchema } from '@graphql-tools/schema';
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

export const schema = makeExecutableSchema({ typeDefs, resolvers });
