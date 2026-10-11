import { describe, expect, it } from 'vitest';
import { qrOrderSettled, qrStatusOf, qrSteps } from '../src/relay-status.js';

const line = (
  state: Parameters<typeof qrStatusOf>[0]['lines'][number]['state'],
  id = 'a',
  endReason: string | null = null,
) => ({
  clientLineId: `0199a0e0-0000-7000-8000-00000000000${id === 'a' ? '1' : '2'}`,
  state,
  endReason,
});

describe('[QR-007] what the diner’s QR page says', () => {
  it('says received while the waiter has not approved', () => {
    expect(
      qrStatusOf({ outcome: 'CREATED', rejectionReason: null, lines: [line('PENDING_APPROVAL')] }),
    ).toEqual({
      status: 'RECEIVED',
      detail: {},
    });
  });

  it('says sent to the kitchen, with each line’s state (S)', () => {
    const target = qrStatusOf({
      outcome: 'CREATED',
      rejectionReason: null,
      lines: [line('PREPARING'), line('CANCELLED', 'b')],
    });
    expect(target.status).toBe('SENT_TO_KITCHEN');
    expect(target.detail.items?.map((item) => item.state)).toEqual(['PREPARING', 'CANCELLED']);
  });

  it('says rejected with the waiter’s reason, or why nothing could be made', () => {
    expect(
      qrStatusOf({
        outcome: 'CREATED',
        rejectionReason: null,
        lines: [line('REJECTED', 'a', 'Kitchen closing')],
      }),
    ).toEqual({ status: 'REJECTED', detail: { rejectionReason: 'Kitchen closing' } });
    expect(
      qrStatusOf({ outcome: 'REJECTED', rejectionReason: 'Dal is out of stock.', lines: [] }),
    ).toEqual({
      status: 'REJECTED',
      detail: { rejectionReason: 'Dal is out of stock.' },
    });
    expect(qrStatusOf({ outcome: 'EXPIRED', rejectionReason: null, lines: [] }).status).toBe(
      'EXPIRED',
    );
  });
});

describe('[QR-007] how long a diner’s page follows an order', () => {
  const sent = (...states: Parameters<typeof line>[0][]) => ({
    status: 'SENT_TO_KITCHEN' as const,
    detail: { items: states.map((state, index) => line(state, index === 0 ? 'a' : 'b')) },
  });

  it('follows it until every dish is served or taken off', () => {
    expect(qrOrderSettled({ status: 'SUBMITTED', detail: {} })).toBe(false);
    expect(qrOrderSettled({ status: 'RECEIVED', detail: {} })).toBe(false);
    expect(qrOrderSettled(sent('SERVED', 'READY'))).toBe(false);
    expect(qrOrderSettled(sent('SERVED', 'CANCELLED'))).toBe(true);
    expect(qrOrderSettled(sent('VOIDED'))).toBe(true);
    // Without the lines' states it cannot tell, so it keeps following.
    expect(qrOrderSettled({ status: 'SENT_TO_KITCHEN', detail: {} })).toBe(false);
  });

  it('stops once the restaurant rejected it or it expired', () => {
    expect(qrOrderSettled({ status: 'REJECTED', detail: {} })).toBe(true);
    expect(qrOrderSettled({ status: 'EXPIRED', detail: {} })).toBe(true);
  });
});

describe('[QR-007] telling the relay in the order it accepts', () => {
  it('receives on the way, and never goes back', () => {
    expect(qrSteps(null, 'RECEIVED')).toEqual(['RECEIVED']);
    expect(qrSteps(null, 'SENT_TO_KITCHEN')).toEqual(['RECEIVED', 'SENT_TO_KITCHEN']);
    expect(qrSteps(null, 'REJECTED')).toEqual(['RECEIVED', 'REJECTED']);
    expect(qrSteps('RECEIVED', 'SENT_TO_KITCHEN')).toEqual(['SENT_TO_KITCHEN']);
    expect(qrSteps('SENT_TO_KITCHEN', 'SENT_TO_KITCHEN')).toEqual(['SENT_TO_KITCHEN']);
    expect(qrSteps('SENT_TO_KITCHEN', 'RECEIVED')).toEqual([]);
    expect(qrSteps(null, 'EXPIRED')).toEqual(['EXPIRED']);
    expect(qrSteps('RECEIVED', 'EXPIRED')).toEqual([]);
    expect(qrSteps('REJECTED', 'SENT_TO_KITCHEN')).toEqual([]);
  });
});

describe('[QR-011] what a diner’s request says', () => {
  it('follows the restaurant’s request: notified, on the way, done', async () => {
    const { qrRequestStatusOf, qrRequestSteps } = await import('../src/relay-status.js');
    expect(qrRequestStatusOf('RAISED', 'ESCALATED')).toBe('RECEIVED');
    expect(qrRequestStatusOf('RAISED', 'ACKNOWLEDGED')).toBe('ACKNOWLEDGED');
    expect(qrRequestStatusOf('RAISED', 'RESOLVED')).toBe('DONE');
    expect(qrRequestStatusOf('REJECTED', null)).toBe('REJECTED');
    expect(qrRequestSteps(null, 'DONE')).toEqual(['RECEIVED', 'ACKNOWLEDGED', 'DONE']);
    expect(qrRequestSteps('RECEIVED', 'ACKNOWLEDGED')).toEqual(['ACKNOWLEDGED']);
    expect(qrRequestSteps('ACKNOWLEDGED', 'RECEIVED')).toEqual([]);
    expect(qrRequestSteps('RECEIVED', 'REJECTED')).toEqual(['REJECTED']);
    expect(qrRequestSteps(null, 'EXPIRED')).toEqual(['EXPIRED']);
    expect(qrRequestSteps('DONE', 'DONE')).toEqual([]);
  });
});
