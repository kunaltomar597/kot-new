import type { AlertView } from '@rp/contracts';
import { createTranslator } from '@rp/i18n';
import { describe, expect, it } from 'vitest';
import { alertAge, describeAlert } from '../src/alert-text.js';

const t = createTranslator();

function alert(overrides: Partial<AlertView>): AlertView {
  return {
    id: '0199a0e0-0000-7000-8000-0000000a1e01',
    type: 'ITEM_READY',
    status: 'OPEN',
    tableId: '0199a0e0-0000-7000-8000-00000000b005',
    tableLabel: '5',
    tableSessionId: null,
    orderId: null,
    pagerText: 'T5 READY',
    payload: {},
    raisedByName: null,
    recipientIds: [],
    channels: ['PAGER', 'WAITER_APP'],
    repeatCount: 0,
    escalatedAt: null,
    escalatedTo: [],
    createdAt: '2026-09-26T08:40:00.000Z',
    acknowledgedAt: null,
    acknowledgedById: null,
    clearedAt: null,
    ...overrides,
  };
}

describe('[WTR-006] [NFR-U04] what an alert says on the waiter app and the POS', () => {
  it('names the table first and what waits there, as the pager does', () => {
    expect(
      describeAlert(alert({ payload: { items: ['Paneer Tikka', 'Dal Makhani'] } }), t),
    ).toEqual({ title: 'Table 5 · Food ready', detail: 'Paneer Tikka, Dal Makhani' });
    expect(describeAlert(alert({ payload: {} }), t)).toEqual({
      title: 'Table 5 · Food ready',
      detail: null,
    });
  });

  it('says where a bill or a new order was asked for', () => {
    expect(
      describeAlert(alert({ type: 'BILL_REQUEST', payload: { requestedFrom: 'TABLE_TABLET' } }), t),
    ).toEqual({ title: 'Table 5 · Bill requested', detail: 'Asked on the table tablet' });
    expect(
      describeAlert(
        alert({ type: 'ORDER_PENDING_APPROVAL', payload: { orderNumber: 42, source: 'QR' } }),
        t,
      ),
    ).toEqual({ title: 'Table 5 · New order to approve', detail: 'Order 42 from the QR menu' });
    expect(describeAlert(alert({ type: 'ORDER_PENDING_APPROVAL', payload: {} }), t).detail).toBe(
      null,
    );
    expect(describeAlert(alert({ type: 'BILL_REQUEST', payload: {} }), t).detail).toBeNull();
  });

  it('[NTF-008] shows a manager’s message with their name', () => {
    expect(
      describeAlert(
        alert({
          type: 'MANAGER_NUDGE',
          tableLabel: null,
          payload: { message: 'Come to counter' },
          raisedByName: 'Meera',
        }),
        t,
      ),
    ).toEqual({ title: 'Come to counter', detail: 'From Meera' });
    expect(describeAlert(alert({ type: 'MANAGER_NUDGE', payload: {} }), t)).toEqual({
      title: 'Message from a manager',
      detail: null,
    });
  });

  it('[KDS-006] names the ticket and dishes waiting at the pass, or the takeaway token', () => {
    const waiting = { kotNumber: 12, items: ['Naan'], takeawayToken: null };
    expect(describeAlert(alert({ type: 'READY_NOT_COLLECTED', payload: waiting }), t)).toEqual({
      title: 'Table 5 · Food waiting at the pass',
      detail: 'KOT 12: Naan',
    });
    expect(
      describeAlert(
        alert({
          type: 'READY_NOT_COLLECTED',
          tableLabel: null,
          payload: { ...waiting, takeawayToken: 7 },
        }),
        t,
      ).title,
    ).toBe('Token 7 · Food waiting at the pass');
    expect(
      describeAlert(alert({ type: 'READY_NOT_COLLECTED', payload: { items: ['Naan'] } }), t).detail,
    ).toBe('Naan');
    expect(describeAlert(alert({ type: 'READY_NOT_COLLECTED', payload: {} }), t).detail).toBeNull();
  });

  it('[PGR-013] says which device ran low or went offline', () => {
    const pager = { deviceType: 'PAGER', deviceName: 'Pager 3', online: true, batteryPercent: 12 };
    const device = alert({ type: 'DEVICE_LOW_BATTERY_OR_OFFLINE', tableLabel: null });
    expect(describeAlert({ ...device, payload: pager }, t)).toEqual({
      title: 'Battery low',
      detail: 'Pager 3: 12% battery left. Charge it soon.',
    });
    expect(
      describeAlert({ ...device, payload: { ...pager, deviceName: null, online: false } }, t),
    ).toEqual({
      title: 'Not connected',
      detail: 'The pager is not connected. Check it is switched on and in Wi-Fi range.',
    });
    expect(
      describeAlert({ ...device, payload: { ...pager, batteryPercent: null } }, t).detail,
    ).toBeNull();
  });

  it('has words for every kind of alert', () => {
    expect(describeAlert(alert({ type: 'PRINTER_OFFLINE', tableLabel: null }), t)).toEqual({
      title: 'Printer offline',
      detail: null,
    });
    expect(describeAlert(alert({ type: 'WATER_REQUEST' }), t).title).toBe(
      'Table 5 · Water requested',
    );
  });

  it('says how long an alert has waited', () => {
    const raised = '2026-09-26T08:40:00.000Z';
    expect(alertAge(raised, Date.parse('2026-09-26T08:40:40.000Z'), t)).toBe('Just now');
    expect(alertAge(raised, Date.parse('2026-09-26T08:44:10.000Z'), t)).toBe('4 min ago');
    expect(alertAge(raised, Date.parse('2026-09-26T08:39:00.000Z'), t)).toBe('Just now');
    expect(alertAge(raised, Date.parse('2026-09-26T09:45:00.000Z'), t)).toBe('1 h 05 min ago');
  });
});
