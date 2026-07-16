import type { AuthorRow } from '../rest-backend/data';
import type { Connection, Edge } from './pagination/relay';

/**
 * Concrete resolver-parent types for the Relay connection wrappers, referenced
 * by codegen `mappers`. Keeps the generic pagination helpers reusable while
 * giving the generated resolver types a concrete node shape (AuthorRow).
 */
export type AuthorConnectionModel = Connection<AuthorRow>;
export type AuthorEdgeModel = Edge<AuthorRow>;
