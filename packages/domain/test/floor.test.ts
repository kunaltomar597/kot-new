import { describe, expect, it } from 'vitest';
import {
  reapplyAssignments,
  responsibleWaiters,
  tablesOf,
  tablesWithoutWaiter,
  toWaiterAssignments,
  type WaiterAssignment,
} from '../src/index.js';

const hall = 'hall';
const terrace = 'terrace';
const tables = [
  { id: 'T1', sectionId: hall },
  { id: 'T2', sectionId: hall },
  { id: 'T3', sectionId: hall },
  { id: 'T7', sectionId: terrace },
];

describe('[TBL-002] responsible waiter', () => {
  const assignments: WaiterAssignment[] = [
    { staffId: 'asha', sectionId: hall, tableId: null },
    { staffId: 'ravi', sectionId: hall, tableId: 'T3' },
    { staffId: 'meena', sectionId: terrace, tableId: null },
    { staffId: 'imran', sectionId: terrace, tableId: null },
  ];

  it("is the section's waiter unless someone is given the table itself", () => {
    expect(responsibleWaiters(tables[0]!, assignments)).toEqual(['asha']);
    expect(responsibleWaiters(tables[2]!, assignments)).toEqual(['ravi']);
  });

  it('lets two waiters share a section, first assigned first', () => {
    expect(responsibleWaiters(tables[3]!, assignments)).toEqual(['meena', 'imran']);
  });

  it('is nobody when the section is not assigned', () => {
    expect(responsibleWaiters({ id: 'B1', sectionId: 'bar' }, assignments)).toEqual([]);
    expect(responsibleWaiters(tables[0]!, [])).toEqual([]);
  });

  it('[WTR-002] gives each waiter their own tables', () => {
    expect(tablesOf('asha', tables, assignments)).toEqual(['T1', 'T2']);
    expect(tablesOf('ravi', tables, assignments)).toEqual(['T3']);
    expect(tablesOf('imran', tables, assignments)).toEqual(['T7']);
    expect(tablesOf('nobody', tables, assignments)).toEqual([]);
  });

  it('counts a waiter once when assigned twice', () => {
    const twice: WaiterAssignment[] = [
      { staffId: 'ravi', sectionId: hall, tableId: 'T1' },
      { staffId: 'ravi', sectionId: hall, tableId: 'T1' },
    ];
    expect(responsibleWaiters(tables[0]!, twice)).toEqual(['ravi']);
  });
});

describe('[TBL-002] planning the day', () => {
  const plan = [
    { staffId: 'asha', sectionIds: [hall], tableIds: [] },
    { staffId: 'ravi', sectionIds: [], tableIds: ['T3', 'T9'] },
  ];

  it('turns each person’s sections and tables into assignments, skipping unknown tables', () => {
    expect(toWaiterAssignments(plan, tables)).toEqual([
      { staffId: 'asha', sectionId: hall, tableId: null },
      { staffId: 'ravi', sectionId: hall, tableId: 'T3' },
    ]);
  });

  it('finds the tables nobody looks after', () => {
    const assignments = toWaiterAssignments(plan, tables);
    expect(tablesWithoutWaiter(tables, assignments)).toEqual(['T7']);
    expect(tablesWithoutWaiter(tables, [])).toEqual(['T1', 'T2', 'T3', 'T7']);
  });

  it('gives an earlier day’s plan again without people or places no longer in use', () => {
    const earlier = [
      { staffId: 'asha', sectionIds: [hall, 'rooftop'], tableIds: [] },
      { staffId: 'priya', sectionIds: [terrace], tableIds: [] },
      { staffId: 'ravi', sectionIds: ['rooftop'], tableIds: ['R1'] },
      { staffId: 'meena', sectionIds: [terrace], tableIds: ['T3', 'T3'] },
    ];
    const scope = {
      // Priya was deactivated; the rooftop and its tables were archived.
      staffIds: new Set(['asha', 'ravi', 'meena']),
      sectionIds: new Set([hall, terrace]),
      tableIds: new Set(['T1', 'T2', 'T3', 'T7']),
    };
    expect(reapplyAssignments(earlier, scope)).toEqual({
      assignments: [
        { staffId: 'asha', sectionIds: [hall], tableIds: [] },
        { staffId: 'meena', sectionIds: [terrace], tableIds: ['T3'] },
      ],
      leftOut: ['priya', 'ravi'],
    });
  });
});
