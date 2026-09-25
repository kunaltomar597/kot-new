import { defineStateMachine } from '../state-machine.js';

export const TABLE_STATES = ['FREE', 'OCCUPIED', 'BILL_REQUESTED', 'BILL_PRINTED'] as const;
export type TableState = (typeof TABLE_STATES)[number];

export const TABLE_EVENTS = [
  'OPEN',
  'REQUEST_BILL',
  'PRINT_BILL',
  'ADD_ITEMS',
  'SETTLE_AND_CLOSE',
  'CLOSE_WITHOUT_BILL',
] as const;
export type TableEvent = (typeof TABLE_EVENTS)[number];

/**
 * Table lifecycle (BRD Appendix B, TBL-004). "Needs cleaning" is a Should and not modelled yet.
 *
 * Beyond the diagram: ADD_ITEMS is also allowed from BILL_REQUESTED (a diner asks for the bill
 * and then orders dessert), and CLOSE_WITHOUT_BILL frees a table opened by mistake; the server
 * only allows it when the session has no billable items. Moving a table (TBL-005) moves the
 * session: the service frees the old table and gives the new one the old table's state.
 */
export const tableMachine = defineStateMachine<TableState, TableEvent>({
  name: 'Table',
  states: TABLE_STATES,
  terminal: [],
  transitions: [
    { event: 'OPEN', from: ['FREE'], to: 'OCCUPIED' },
    { event: 'REQUEST_BILL', from: ['OCCUPIED'], to: 'BILL_REQUESTED' },
    { event: 'PRINT_BILL', from: ['OCCUPIED', 'BILL_REQUESTED'], to: 'BILL_PRINTED' },
    { event: 'ADD_ITEMS', from: ['BILL_REQUESTED', 'BILL_PRINTED'], to: 'OCCUPIED' },
    { event: 'SETTLE_AND_CLOSE', from: ['BILL_PRINTED'], to: 'FREE' },
    { event: 'CLOSE_WITHOUT_BILL', from: ['OCCUPIED'], to: 'FREE', requiresReason: true },
  ],
});
