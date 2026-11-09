/**
 * The largest page or bound any list field returns (`authors(first|last)`,
 * `Author.books(first)`, `Book.reviews(first)`).
 *
 * WHY one shared constant: the resolvers clamp to it and the complexity
 * limiter prices fan-out with the same clamp. If the two ever drifted apart,
 * admission would either refuse queries for rows the gateway never fetches or
 * admit work it does not price.
 */
export const MAX_PAGE_SIZE = 100;
