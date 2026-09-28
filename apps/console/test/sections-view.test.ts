import { describe, expect, it } from 'vitest';
import {
  activeFloor,
  assignablePeople,
  dayOf,
  namesOf,
  personDay,
  planOf,
  requestOf,
  sameAsBefore,
  scopeOf,
  uncoveredOf,
  withPlanFor,
} from '../src/manage/staff/sections-view.js';
import {
  assignment,
  crew,
  H1,
  H2,
  HALL,
  MEERA,
  R1,
  RAVI,
  ROOFTOP,
  sectionsFloor,
  SUNIL,
  T7,
  T8,
  TERRACE,
  YESTERDAY,
} from './sections-fixture.js';
import { PRIYA } from './staff-fixture.js';

const floor = activeFloor(sectionsFloor());
const scope = scopeOf(crew(), floor);

describe('[TBL-002] today’s sections', () => {
  it('uses only sections and tables in use, and people who take orders, waiters first', () => {
    expect(floor.map((section) => [section.name, section.tables.map((t) => t.label)])).toEqual([
      ['Hall', ['H1', 'H2']],
      ['Terrace', ['T7', 'T8']],
    ]);
    // Kitchen staff take no orders and Priya is deactivated.
    expect(assignablePeople(crew()).map((person) => person.displayName)).toEqual([
      'Ravi',
      'Sunil',
      'Meera',
      'Asha',
      'Kunal',
    ]);
  });

  it('changes one person’s tables in place, and takes them off when nothing is ticked', () => {
    const plan = [
      { staffId: RAVI, sectionIds: [HALL], tableIds: [] },
      { staffId: SUNIL.id, sectionIds: [TERRACE], tableIds: [] },
    ];
    expect(withPlanFor(plan, { staffId: RAVI, sectionIds: [], tableIds: [T7] })).toEqual([
      { staffId: RAVI, sectionIds: [], tableIds: [T7] },
      { staffId: SUNIL.id, sectionIds: [TERRACE], tableIds: [] },
    ]);
    expect(withPlanFor(plan, { staffId: RAVI, sectionIds: [], tableIds: [] })).toEqual([
      { staffId: SUNIL.id, sectionIds: [TERRACE], tableIds: [] },
    ]);
    expect(withPlanFor(plan, { staffId: MEERA, sectionIds: [HALL], tableIds: [] })).toHaveLength(3);
  });

  it('never sends a place or a person no longer in use', () => {
    const plan = [
      { staffId: RAVI, sectionIds: [HALL, ROOFTOP], tableIds: [R1] },
      { staffId: PRIYA.id, sectionIds: [TERRACE], tableIds: [] },
    ];
    expect(requestOf(plan, scope)).toEqual({
      assignments: [{ staffId: RAVI, sectionIds: [HALL], tableIds: [] }],
    });
  });

  it('says what each person looks after, counting tables given to others out', () => {
    const plan = planOf([assignment(RAVI, [HALL]), assignment(SUNIL.id, [TERRACE], [H2])]);
    expect(personDay(RAVI, plan, floor)).toEqual({
      sections: ['Hall'],
      tables: [],
      tableCount: 1,
    });
    expect(personDay(SUNIL.id, plan, floor)).toEqual({
      sections: ['Terrace'],
      tables: ['H2'],
      tableCount: 3,
    });
    expect(personDay(MEERA, plan, floor)).toEqual({ sections: [], tables: [], tableCount: 0 });
  });

  it('lists the tables nobody looks after, a whole section or some of its tables', () => {
    expect(uncoveredOf([], floor)).toEqual([
      { sectionId: HALL, section: 'Hall', tables: [] },
      { sectionId: TERRACE, section: 'Terrace', tables: [] },
    ]);
    const plan = planOf([assignment(RAVI, [HALL]), assignment(SUNIL.id, [], [T8])]);
    expect(uncoveredOf(plan, floor)).toEqual([
      { sectionId: TERRACE, section: 'Terrace', tables: ['T7'] },
    ]);
    const all = planOf([assignment(RAVI, [HALL, TERRACE])]);
    expect(uncoveredOf(all, floor)).toEqual([]);
  });

  it('gives the last day’s sections again, naming who is left out', () => {
    const previous = {
      businessDate: YESTERDAY,
      assignments: [
        assignment(RAVI, [HALL], [H1]),
        assignment(PRIYA.id, [TERRACE]),
        assignment(SUNIL.id, [ROOFTOP]),
      ],
    };
    expect(sameAsBefore(previous, scope)).toEqual({
      plan: [{ staffId: RAVI, sectionIds: [HALL], tableIds: [H1] }],
      leftOut: ['Priya', 'Sunil'],
    });
  });

  it('says days and names as people do', () => {
    expect(dayOf('2026-09-27', 'en-IN')).toBe('Sunday, 27 September');
    expect(namesOf(['Priya'], 'en-IN')).toBe('Priya');
    expect(namesOf(['Priya', 'Sunil'], 'en-IN')).toBe('Priya and Sunil');
  });
});
