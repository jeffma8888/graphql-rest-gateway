import { GraphQLError } from 'graphql';
import type { Resolvers } from '../generated/graphql';

/**
 * Resolvers are deliberately THIN: they translate a GraphQL field into a single
 * service call and nothing more. No fetch logic, no batching logic, no URL
 * knowledge -- all of that lives below in services -> loaders -> datasources.
 *
 * Parent types are the raw REST rows (AuthorRow/BookRow/ReviewRow) via codegen
 * `mappers`; scalar fields (id, name, title, ...) fall through to GraphQL's
 * default field resolver, so only the graph "edges" need explicit resolvers.
 */
export const resolvers: Resolvers = {
  Query: {
    authors: (_parent, args, ctx) => ctx.services.author.listConnection(args.first ?? 10, args.after),
    author: async (_parent, args, ctx) => {
      const author = await ctx.services.author.getAuthor(args.id);
      if (!author) {
        throw new GraphQLError(`Author ${args.id} not found`, {
          extensions: { code: 'NOT_FOUND', id: args.id },
        });
      }
      return author;
    },
    book: async (_parent, args, ctx) => {
      const book = await ctx.services.book.getBook(args.id);
      if (!book) {
        throw new GraphQLError(`Book ${args.id} not found`, {
          extensions: { code: 'NOT_FOUND', id: args.id },
        });
      }
      return book;
    },
  },

  Author: {
    books: (author, _args, ctx) => ctx.services.book.booksForAuthor(author.id),
  },

  Book: {
    author: async (book, _args, ctx) => {
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
    reviews: (book, _args, ctx) => ctx.services.review.reviewsForBook(book.id),
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
