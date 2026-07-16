/**
 * Canned dataset for the bundled downstream REST service.
 *
 * These row types are the RAW shapes the REST backend returns. They are also
 * the resolver "parent" types (see codegen `mappers`) -- the gateway maps them
 * onto the GraphQL output types. Data is generated deterministically so the
 * N+1 benchmark and regression test produce stable, reproducible call counts.
 *
 * Shape: 5 authors x 3 books each x 2 reviews each = 5 authors, 15 books, 30 reviews.
 */

export interface AuthorRow {
  id: string;
  name: string;
  bio: string;
}

export interface BookRow {
  id: string;
  authorId: string;
  title: string;
  year: number;
}

export interface ReviewRow {
  id: string;
  bookId: string;
  rating: number;
  body: string;
  reviewer: string;
}

const AUTHOR_SEED: ReadonlyArray<{ name: string; bio: string }> = [
  { name: 'Ada Lovelace', bio: 'Wrote the first algorithm intended for a machine.' },
  { name: 'Alan Turing', bio: 'Formalized computation and the notion of the algorithm.' },
  { name: 'Grace Hopper', bio: 'Pioneered machine-independent programming languages.' },
  { name: 'Edsger Dijkstra', bio: 'Championed structured programming and correctness.' },
  { name: 'Barbara Liskov', bio: 'Invented abstract data types and the Liskov substitution principle.' },
];

const REVIEWERS: ReadonlyArray<string> = ['nadia', 'omar', 'sofia', 'liang', 'priya', 'diego'];

function buildDataset(): {
  authors: AuthorRow[];
  books: BookRow[];
  reviews: ReviewRow[];
} {
  const authors: AuthorRow[] = [];
  const books: BookRow[] = [];
  const reviews: ReviewRow[] = [];

  AUTHOR_SEED.forEach((seed, ai) => {
    const authorId = `a${ai + 1}`;
    authors.push({ id: authorId, name: seed.name, bio: seed.bio });

    // 3 books per author
    for (let bi = 0; bi < 3; bi++) {
      const bookId = `${authorId}-b${bi + 1}`;
      books.push({
        id: bookId,
        authorId,
        title: `${seed.name.split(' ')[0]}'s Volume ${bi + 1}`,
        year: 1990 + ((ai * 3 + bi) % 30),
      });

      // 2 reviews per book
      for (let ri = 0; ri < 2; ri++) {
        const reviewId = `${bookId}-r${ri + 1}`;
        reviews.push({
          id: reviewId,
          bookId,
          rating: 3 + ((ai + bi + ri) % 3), // 3..5
          body: `Review ${ri + 1} for ${bookId}.`,
          reviewer: REVIEWERS[(ai * 6 + bi * 2 + ri) % REVIEWERS.length]!,
        });
      }
    }
  });

  return { authors, books, reviews };
}

const dataset = buildDataset();

export const AUTHORS: ReadonlyArray<AuthorRow> = dataset.authors;
export const BOOKS: ReadonlyArray<BookRow> = dataset.books;
export const REVIEWS: ReadonlyArray<ReviewRow> = dataset.reviews;

/** Deterministic totals, exported for tests/benchmark assertions. */
export const DATASET_SIZE = {
  authors: dataset.authors.length,
  books: dataset.books.length,
  reviews: dataset.reviews.length,
} as const;
