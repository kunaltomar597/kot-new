import { describe, expect, it } from 'vitest';
import {
  allowedEvents,
  canRaiseServiceRequest,
  canTransition,
  cancelButtonEvent,
  defineStateMachine,
  effectiveLicenseState,
  initialOrderItemState,
  isBillable,
  isCustomerSource,
  isKitchenActive,
  isOpenServiceRequest,
  isTerminal,
  licenseCapabilities,
  licenseMachine,
  orderItemMachine,
  restrictionEffectiveAt,
  serviceRequestMachine,
  tableMachine,
  transition,
} from '../src/index.js';

describe('[ORD-002] order item state machine (Appendix B)', () => {
  it('[ORD-003] starts customer orders in approval and staff orders as sent', () => {
    expect(isCustomerSource('QR')).toBe(true);
    expect(isCustomerSource('POS')).toBe(false);
    expect(initialOrderItemState('TABLE_TABLET')).toBe('PENDING_APPROVAL');
    expect(initialOrderItemState('QR')).toBe('PENDING_APPROVAL');
    expect(initialOrderItemState('WAITER_APP')).toBe('SENT');
    expect(initialOrderItemState('POS')).toBe('SENT');
  });

  it('follows the happy path', () => {
    expect(transition(orderItemMachine, 'PENDING_APPROVAL', 'APPROVE').to).toBe('SENT');
    expect(transition(orderItemMachine, 'SENT', 'START_PREPARING').to).toBe('PREPARING');
    expect(transition(orderItemMachine, 'PREPARING', 'MARK_READY').to).toBe('READY');
    expect(transition(orderItemMachine, 'READY', 'PICK_UP').to).toBe('PICKED_UP');
    expect(transition(orderItemMachine, 'PICKED_UP', 'SERVE').to).toBe('SERVED');
  });

  it('[ORD-011] enforces cancellation and void rules', () => {
    const reject = transition(orderItemMachine, 'PENDING_APPROVAL', 'REJECT');
    expect(reject.requiresReason).toBe(true);
    const cancel = transition(orderItemMachine, 'SENT', 'CANCEL');
    expect(cancel.to).toBe('CANCELLED');
    expect(cancel.requiresReason).toBe(true);
    expect(cancel.requiresManagerOverride).toBeUndefined();
    expect(canTransition(orderItemMachine, 'PREPARING', 'CANCEL')).toBe(false);
    for (const from of ['PREPARING', 'READY', 'PICKED_UP', 'SERVED'] as const) {
      const voided = transition(orderItemMachine, from, 'VOID');
      expect(voided.to).toBe('VOIDED');
      expect(voided.requiresManagerOverride).toBe(true);
    }
    expect(canTransition(orderItemMachine, 'SENT', 'VOID')).toBe(false);
    expect(() => transition(orderItemMachine, 'VOIDED', 'SERVE')).toThrow(
      /cannot SERVE from VOIDED/,
    );
  });

  it('knows billable and kitchen-active states', () => {
    expect(isBillable('SERVED')).toBe(true);
    expect(isBillable('PENDING_APPROVAL')).toBe(false);
    expect(isBillable('VOIDED')).toBe(false);
    expect(isKitchenActive('PREPARING')).toBe(true);
    expect(isKitchenActive('SERVED')).toBe(false);
    expect(isTerminal(orderItemMachine, 'CANCELLED')).toBe(true);
    expect(allowedEvents(orderItemMachine, 'SENT')).toEqual([
      'START_PREPARING',
      'MARK_READY',
      'CANCEL',
    ]);
  });
});

describe('state machine definitions are validated', () => {
  it('rejects duplicates, unknown states and transitions out of terminal states', () => {
    expect(() =>
      defineStateMachine({
        name: 'Bad',
        states: ['A', 'B'],
        terminal: [],
        transitions: [
          { event: 'GO', from: ['A'], to: 'B' },
          { event: 'GO', from: ['A'], to: 'A' },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      defineStateMachine({
        name: 'Bad',
        states: ['A'],
        terminal: [],
        transitions: [{ event: 'GO', from: ['A'], to: 'Z' as 'A' }],
      }),
    ).toThrow(/unknown target/);
    expect(() =>
      defineStateMachine({
        name: 'Bad',
        states: ['A'],
        terminal: [],
        transitions: [{ event: 'GO', from: ['Z' as 'A'], to: 'A' }],
      }),
    ).toThrow(/unknown source/);
    expect(() =>
      defineStateMachine({
        name: 'Bad',
        states: ['A', 'B'],
        terminal: ['A'],
        transitions: [{ event: 'GO', from: ['A'], to: 'B' }],
      }),
    ).toThrow(/terminal/);
  });
});

describe('[TBL-004] table state machine', () => {
  it('follows Free → Occupied → Bill requested → Bill printed → Free', () => {
    expect(transition(tableMachine, 'FREE', 'OPEN').to).toBe('OCCUPIED');
    expect(transition(tableMachine, 'OCCUPIED', 'REQUEST_BILL').to).toBe('BILL_REQUESTED');
    expect(transition(tableMachine, 'BILL_REQUESTED', 'PRINT_BILL').to).toBe('BILL_PRINTED');
    expect(transition(tableMachine, 'BILL_PRINTED', 'ADD_ITEMS').to).toBe('OCCUPIED');
    expect(transition(tableMachine, 'OCCUPIED', 'PRINT_BILL').to).toBe('BILL_PRINTED');
    expect(transition(tableMachine, 'BILL_PRINTED', 'SETTLE_AND_CLOSE').to).toBe('FREE');
    expect(canTransition(tableMachine, 'FREE', 'PRINT_BILL')).toBe(false);
    expect(canTransition(tableMachine, 'OCCUPIED', 'SETTLE_AND_CLOSE')).toBe(false);
    expect(transition(tableMachine, 'OCCUPIED', 'CLOSE_WITHOUT_BILL').requiresReason).toBe(true);
  });
});

describe('[TAB-004] service request state machine', () => {
  it('escalates, acknowledges, cancels and resolves', () => {
    expect(transition(serviceRequestMachine, 'ACTIVE', 'ESCALATE').to).toBe('ESCALATED');
    expect(transition(serviceRequestMachine, 'ESCALATED', 'ACKNOWLEDGE').to).toBe('ACKNOWLEDGED');
    expect(transition(serviceRequestMachine, 'ACKNOWLEDGED', 'RESOLVE').to).toBe('RESOLVED');
    expect(transition(serviceRequestMachine, 'ACTIVE', 'CANCEL').to).toBe('CANCELLED');
    expect(canTransition(serviceRequestMachine, 'ACKNOWLEDGED', 'ESCALATE')).toBe(false);
  });

  it('maps the Cancel button like a cabin call light', () => {
    expect(cancelButtonEvent('ACTIVE')).toBe('CANCEL');
    expect(cancelButtonEvent('ESCALATED')).toBe('CANCEL');
    expect(cancelButtonEvent('ACKNOWLEDGED')).toBe('RESOLVE');
    expect(cancelButtonEvent('RESOLVED')).toBeUndefined();
  });

  it('blocks raising the same request type twice (anti-spam)', () => {
    expect(isOpenServiceRequest('ACKNOWLEDGED')).toBe(true);
    expect(isOpenServiceRequest('CANCELLED')).toBe(false);
    expect(canRaiseServiceRequest('WATER', [{ type: 'WATER', state: 'ACTIVE' }])).toBe(false);
    expect(canRaiseServiceRequest('WATER', [{ type: 'WATER', state: 'RESOLVED' }])).toBe(true);
    expect(canRaiseServiceRequest('BILL', [{ type: 'WATER', state: 'ACTIVE' }])).toBe(true);
  });
});

describe('[LIC-005] licence states', () => {
  it('moves through the staged kill switch', () => {
    expect(transition(licenseMachine, 'ACTIVE', 'INVOICE_OVERDUE').to).toBe('PAYMENT_DUE');
    expect(transition(licenseMachine, 'PAYMENT_DUE', 'START_GRACE').to).toBe('GRACE');
    expect(transition(licenseMachine, 'GRACE', 'GRACE_ENDED').to).toBe('RESTRICTED');
    expect(transition(licenseMachine, 'RESTRICTED', 'PAYMENT_RECORDED').to).toBe('ACTIVE');
    expect(transition(licenseMachine, 'ACTIVE', 'INVALIDATED').to).toBe('RESTRICTED');
    expect(transition(licenseMachine, 'RESTRICTED', 'CONTRACT_ENDED').to).toBe('TERMINATED');
    expect(isTerminal(licenseMachine, 'TERMINATED')).toBe(true);
  });

  it('never withholds data in restricted states', () => {
    for (const state of ['RESTRICTED', 'TERMINATED'] as const) {
      const caps = licenseCapabilities(state);
      expect(caps.createOrders).toBe(false);
      expect(caps.openNewTableSessions).toBe(false);
      expect(caps.billOpenTables).toBe(true);
      expect(caps.exportData).toBe(true);
      expect(caps.backups).toBe(true);
      expect(caps.viewReports).toBe(true);
    }
    expect(licenseCapabilities('ACTIVE').showPaymentReminder).toBe(false);
    expect(licenseCapabilities('PAYMENT_DUE')).toMatchObject({
      createOrders: true,
      showPaymentReminder: true,
    });
    expect(licenseCapabilities('GRACE')).toMatchObject({
      createOrders: true,
      showGraceBanner: true,
    });
  });

  it('applies restriction only from the next business day', () => {
    // Decided at 21:00 IST on 25 Sep, mid-service.
    const decidedAt = new Date('2026-09-25T15:30:00Z');
    const effective = restrictionEffectiveAt(decidedAt);
    expect(effective.toISOString()).toBe('2026-09-25T22:30:00.000Z');
    expect(
      effectiveLicenseState('RESTRICTED', 'GRACE', effective, new Date('2026-09-25T18:00:00Z')),
    ).toBe('GRACE');
    expect(
      effectiveLicenseState('RESTRICTED', 'GRACE', effective, new Date('2026-09-25T22:30:00Z')),
    ).toBe('RESTRICTED');
    expect(effectiveLicenseState('ACTIVE', 'GRACE', undefined, new Date())).toBe('ACTIVE');
    expect(effectiveLicenseState('RESTRICTED', 'GRACE', undefined, new Date())).toBe('RESTRICTED');
  });
});
