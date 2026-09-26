import { describe, expect, it } from 'vitest';
import { TableRequest, UpdateWaiterAssignmentsRequest } from '../src/index.js';

const id = (n: number) => `01926a3e-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('[TBL-001] tables', () => {
  it('takes a label, seats and a section', () => {
    const table = { label: 'Terrace 3', capacity: 4, sectionId: id(1), displayOrder: 0 };
    expect(TableRequest.safeParse(table).success).toBe(true);
    expect(TableRequest.safeParse({ ...table, capacity: 0 }).success).toBe(false);
    expect(TableRequest.safeParse({ ...table, label: ' ' }).success).toBe(false);
    expect(TableRequest.safeParse({ ...table, label: 'x'.repeat(21) }).success).toBe(false);
  });
});

describe('[TBL-002] waiter assignment request', () => {
  it('lists each waiter once with at least one section or table', () => {
    const one = { staffId: id(1), sectionIds: [id(2)], tableIds: [] };
    expect(UpdateWaiterAssignmentsRequest.safeParse({ assignments: [one] }).success).toBe(true);
    expect(UpdateWaiterAssignmentsRequest.safeParse({ assignments: [] }).success).toBe(true);
    expect(
      UpdateWaiterAssignmentsRequest.safeParse({
        assignments: [one, { ...one, sectionIds: [id(3)] }],
      }).success,
    ).toBe(false);
    expect(
      UpdateWaiterAssignmentsRequest.safeParse({
        assignments: [{ staffId: id(1), sectionIds: [], tableIds: [] }],
      }).success,
    ).toBe(false);
  });
});
