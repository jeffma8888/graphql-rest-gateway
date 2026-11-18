import type { ReviewRow } from '../../rest-backend/data.js';
import { REVIEW_FIELDS, describeKind, readRow } from './contract.js';
import type { RestClient } from './rest-client.js';

/**
 * REST WRITE data sources: the downstream routes that change data. WHY a
 * module of their own, apart from the read sources in `./index`: `npm run
 * check-backend` probes every read route in `./index` before cut-over, and a
 * write must never be probed (it would create data on the operator's
 * backend), so the two route lists are kept apart by construction.
 */

/** The `POST /reviews` body: a review row minus the id the backend assigns. */
export type NewReview = Omit<ReviewRow, 'id'>;

const reviewRow = (body: unknown): ReviewRow => readRow<ReviewRow>(body, REVIEW_FIELDS, describeKind, 'review');

export class ReviewWriteDataSource {
  constructor(private readonly client: RestClient) {}

  /** Creates one review; the reply is the stored row, contract-checked like a read. */
  addReview(input: NewReview): Promise<ReviewRow> {
    return this.client.post('/reviews', input, reviewRow);
  }
}
