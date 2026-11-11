import { GraphQLError } from 'graphql';
import type { Resolvers } from '../generated/graphql.js';
import { willResolveChild } from './lookahead.js';
import { MAX_PAGE_SIZE } from './pagination/page-size.js';

/**
 * Resolvers are deliberately THIN: each translates a GraphQL field into service
 * calls (its own load, plus at most one lookahead prefetch) and nothing more.
 * No fetch logic, no batching logic, no URL knowledge -- all of that lives
 * below in services -> loaders -> datasources.
 *
 * Parent types are the raw REST rows (AuthorRow/BookRow/ReviewRow) via codegen
 * `mappers`; scalar fields (id, name, title, ...) fall through to GraphQL's
 * default field resolver, so only the graph "edges" need explicit resolvers.
 *
 * By-id roots also kick off a lookahead prefetch (see `./lookahead`): the
 * child edge's key is `args.id` (each of `args.ids` for `books(ids:)`), so
 * its batched load need not wait for the root fetch to return. `Book.author`
 * does the same one level down: the key `Author.books` needs is
 * `book.authorId`, already on the parent row, so the author's books load
 * starts in the same tick as the author load.
 */
export const resolvers: Resolvers = {
  // Roots that call `willResolveChild` must be listed in BY_ID_ROOTS (lookahead.ts).
  Query: {
    authors: (_parent, args, ctx) => ctx.services.author.listConnection(args),
    author: async (_parent, args, ctx, info) => {
      if (willResolveChild(info, 'books')) ctx.services.book.prefetchBooksForAuthor(args.id);
      const author = await ctx.services.author.getAuthor(args.id);
      if (!author) {
        throw new GraphQLError(`Author ${args.id} not found`, {
          extensions: { code: 'NOT_FOUND', id: args.id },
        });
      }
      return author;
    },
    book: async (_parent, args, ctx, info) => {
      if (willResolveChild(info, 'reviews')) ctx.services.review.prefetchReviewsForBook(args.id);
      const book = await ctx.services.book.getBook(args.id);
      if (!book) {
        throw new GraphQLError(`Book ${args.id} not found`, {
          extensions: { code: 'NOT_FOUND', id: args.id },
        });
      }
      return book;
    },
    // A by-id root too (BY_ID_ROOTS, lookahead.ts): every key `Book.reviews`
    // needs is already in `args.ids`, so their reviews load in one batch in the
    // same tick as `/books/by-ids` (`author{ books }` rides the Book.author gate).
    // The prefetch runs AFTER the size refusal, so an oversized list still costs
    // 0 downstream calls; a missing id spends its speculative reviews call.
    books: (_parent, args, ctx, info) => {
      if (args.ids.length > MAX_PAGE_SIZE) {
        // Refused before any load, so an oversized list costs 0 downstream calls.
        throw new GraphQLError(
          `Argument \`ids\` accepts at most ${MAX_PAGE_SIZE} ids; received ${args.ids.length}.`,
          {
            extensions: {
              code: 'BAD_ARGUMENT',
              argument: 'ids',
              max: MAX_PAGE_SIZE,
              received: args.ids.length,
            },
          },
        );
      }
      if (willResolveChild(info, 'reviews')) {
        for (const id of args.ids) ctx.services.review.prefetchReviewsForBook(id);
      }
      // One promise per item (not Promise.all): graphql-js completes each at its
      // own index, so an unknown id nulls only its slot and the error path is
      // ["books", i]. All loads land in one tick -> one batched, deduped call.
      return args.ids.map(async (id) => {
        const book = await ctx.services.book.getBook(id);
        if (!book) {
          throw new GraphQLError(`Book ${id} not found`, { extensions: { code: 'NOT_FOUND', id } });
        }
        return book;
      });
    },
  },

  Author: {
    books: (author, args, ctx) => ctx.services.book.booksForAuthor(author.id, args.first),
  },

  Book: {
    author: async (book, _args, ctx, info) => {
      // Same root-safety gate as the by-id roots (see lookahead.ts). Under it,
      // every Book.author -> books load of the operation moves up by the same
      // one hop, so batches are shifted together, never split: call counts are
      // unchanged. That holds within ONE operation: every Author node comes from
      // author(id) or Book.author, and both prefetch. A new Author-returning edge
      // must prefetch too, or this breaks. Ops sharing loaders in an opt-in HTTP
      // batch can still split a batch (+1 call; same as the root lookahead).
      // Cost: an orphan row (no such author) still spends this call.
      if (willResolveChild(info, 'books')) ctx.services.book.prefetchBooksForAuthor(book.authorId);
      const author = await ctx.services.author.getAuthor(book.authorId);
      if (!author) {
        // Non-null field: throwing here triggers GraphQL null propagation,
        // surfacing a partial error rather than a corrupt response.
        throw new GraphQLError(`Author ${book.authorId} not found for book ${book.id}`, {
          extensions: { code: 'NOT_FOUND' },
        });
      }
      return author;
    },
    reviews: (book, args, ctx) => ctx.services.review.reviewsForBook(book.id, args.first),
  },

  Review: {
    // PII field: requires both authentication and the 'pii' scope.
    reviewer: (review, _args, ctx) =>
      ctx.auth.userId && ctx.auth.scopes.includes('pii') ? review.reviewer : 'REDACTED',
    book: async (review, _args, ctx) => {
      const book = await ctx.services.book.getBook(review.bookId);
      if (!book) {
        throw new GraphQLError(`Book ${review.bookId} not found for review ${review.id}`, {
          extensions: { code: 'NOT_FOUND' },
        });
      }
      return book;
    },
  },
};
