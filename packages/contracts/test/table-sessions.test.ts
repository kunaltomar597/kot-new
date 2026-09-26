import { describe, expect, it } from 'vitest';
import { CloseWithoutBillRequest, OpenTableRequest } from '../src/index.js';

describe('[TBL-003] opening a table', () => {
  it('takes covers and an optional waiter', () => {
    expect(OpenTableRequest.safeParse({ covers: 4 }).success).toBe(true);
    expect(OpenTableRequest.safeParse({ covers: 0 }).success).toBe(false);
    expect(OpenTableRequest.safeParse({ covers: 2.5 }).success).toBe(false);
    expect(OpenTableRequest.safeParse({ covers: 2, waiterId: 'someone' }).success).toBe(false);
  });

  it('[TBL-004] needs a reason to close a table without a bill', () => {
    expect(CloseWithoutBillRequest.safeParse({ reason: 'Wrong table' }).success).toBe(true);
    expect(CloseWithoutBillRequest.safeParse({ reason: ' ' }).success).toBe(false);
  });
});
