import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { resolvers } from './resolvers';

/**
 * Schema-first assembly: read the SDL from `schema.graphql` (the source of
 * truth) and bind the resolvers to it. `schema.graphql` lives at the repo root,
 * two levels up from this module (src/gateway/schema.ts).
 */
const here = dirname(fileURLToPath(import.meta.url));
export const typeDefs = readFileSync(join(here, '..', '..', 'schema.graphql'), 'utf8');

export const schema = makeExecutableSchema({ typeDefs, resolvers });
