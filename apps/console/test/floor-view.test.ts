import { describe, expect, it } from 'vitest';
import {
  activeSections,
  checkSection,
  checkTable,
  emptySectionForm,
  emptyTableForm,
  floorSections,
  nextTablePlace,
  sectionFormOf,
  sectionRequestOf,
  type TableForm,
  tableFormOf,
  tableOf,
  tableRequestOf,
} from '../src/manage/settings/floor-view.js';
import {
  floor,
  MAIN,
  ROOF,
  section,
  TABLE_1,
  TABLE_2,
  TABLE_3,
  TABLE_R1,
  TABLE_T1,
  TERRACE,
} from './floor-fixture.js';

const labelsOf = (archived: boolean) =>
  floorSections(floor(), { archived }).map((entry) => ({
    name: entry.section.name,
    tables: entry.tables.map((table) => table.label),
    tableCount: entry.tableCount,
    seats: entry.seats,
  }));

describe('[TBL-001] the floor as the page lists it', () => {
  it('lists the sections in order with their tables, counting active tables and their seats', () => {
    expect(labelsOf(false)).toEqual([
      { name: 'Main Hall', tables: ['1', '2'], tableCount: 2, seats: 10 },
      { name: 'Terrace', tables: ['T1'], tableCount: 1, seats: 4 },
    ]);
  });

  it('adds archived sections and tables when asked, still counting only the active ones', () => {
    expect(labelsOf(true)).toEqual([
      { name: 'Main Hall', tables: ['1', '2', '3'], tableCount: 2, seats: 10 },
      { name: 'Terrace', tables: ['T1'], tableCount: 1, seats: 4 },
      { name: 'Roof', tables: ['R1'], tableCount: 0, seats: 0 },
    ]);
  });

  it('offers only active sections for a table, and finds a table by id', () => {
    expect(activeSections(floor()).map((entry) => entry.id)).toEqual([MAIN, TERRACE]);
    expect(tableOf(floor(), TABLE_T1)?.label).toBe('T1');
    expect(tableOf(floor(), TABLE_R1)?.archivedAt).not.toBeNull();
    expect(tableOf(floor(), MAIN)).toBeUndefined();
  });
});

describe('[TBL-001] [ONB-004] the section form', () => {
  it('puts a new section after every other, archived ones included, within 999', () => {
    expect(emptySectionForm(floor())).toEqual({ name: '', displayOrder: '4' });
    expect(emptySectionForm({ sections: [] })).toEqual({ name: '', displayOrder: '1' });
    expect(
      emptySectionForm({ sections: [section({ id: MAIN, name: 'Main Hall', displayOrder: 999 })] }),
    ).toEqual({ name: '', displayOrder: '999' });
  });

  it('asks for a name no other active section has, whatever its case and spaces', () => {
    const add = (name: string) => checkSection({ name, displayOrder: '4' }, floor(), undefined);
    expect(add('Garden')).toEqual({});
    expect(add('   ')).toEqual({ name: 'nameRequired' });
    expect(add('x'.repeat(41))).toEqual({ name: 'nameRequired' });
    expect(add(' terrace ')).toEqual({ name: 'nameTaken' });
    // An archived section's name is free again; restoring it is refused by the server if needed.
    expect(add('Roof')).toEqual({});
    // A section keeps its own name.
    expect(checkSection(sectionFormOf(floor().sections[1]!), floor(), TERRACE)).toEqual({});
  });

  it('asks for a whole-number place from 0 to 999', () => {
    const place = (displayOrder: string) =>
      checkSection({ name: 'Garden', displayOrder }, floor(), undefined).displayOrder;
    expect(place('0')).toBeUndefined();
    expect(place(' 999 ')).toBeUndefined();
    expect(place('1000')).toBe('place');
    expect(place('-1')).toBe('place');
    expect(place('2.5')).toBe('place');
    expect(place('')).toBe('place');
  });

  it('sends the name and place trimmed', () => {
    expect(sectionRequestOf({ name: '  Garden ', displayOrder: ' 7 ' })).toEqual({
      name: 'Garden',
      displayOrder: 7,
    });
  });
});

describe('[TBL-001] [ONB-004] the table form', () => {
  const form = (overrides: Partial<TableForm> = {}): TableForm => ({
    label: '9',
    capacity: '4',
    sectionId: MAIN,
    displayOrder: '4',
    ...overrides,
  });

  it('lays a new table for four after the tables of its section, archived ones included', () => {
    expect(nextTablePlace(floor(), MAIN)).toBe(4);
    expect(nextTablePlace(floor(), TERRACE)).toBe(2);
    expect(emptyTableForm(floor(), MAIN)).toEqual({
      label: '',
      capacity: '4',
      sectionId: MAIN,
      displayOrder: '4',
    });
    // No section, or an archived one: the manager chooses one.
    expect(emptyTableForm(floor(), undefined)).toMatchObject({ sectionId: '', displayOrder: '1' });
    expect(emptyTableForm(floor(), ROOF)).toMatchObject({ sectionId: '', displayOrder: '1' });
  });

  it('asks for a label no other table has, and says when an archived table has it', () => {
    const label = (text: string, selfId?: string) =>
      checkTable(form({ label: text }), floor(), selfId).label;
    expect(label('9')).toBeUndefined();
    expect(label(' ')).toBe('labelRequired');
    expect(label('x'.repeat(21))).toBe('labelRequired');
    expect(label(' t1 ')).toBe('labelTaken');
    // Labels name tables on old tickets and bills, so an archived table's label stays taken.
    expect(label('3')).toBe('labelArchived');
    expect(label('r1')).toBe('labelArchived');
    // A table keeps its own label.
    expect(label('2', TABLE_2)).toBeUndefined();
    expect(label('3', TABLE_3)).toBeUndefined();
  });

  it('asks for 1 to 50 seats, an active section and a place from 0 to 9,999', () => {
    const problems = (overrides: Partial<TableForm>) =>
      checkTable(form(overrides), floor(), undefined);
    expect(problems({})).toEqual({});
    expect(problems({ capacity: '0' })).toEqual({ capacity: 'capacity' });
    expect(problems({ capacity: '51' })).toEqual({ capacity: 'capacity' });
    expect(problems({ capacity: 'four' })).toEqual({ capacity: 'capacity' });
    expect(problems({ capacity: ' 50 ' })).toEqual({});
    expect(problems({ sectionId: '' })).toEqual({ sectionId: 'sectionMissing' });
    expect(problems({ sectionId: ROOF })).toEqual({ sectionId: 'sectionMissing' });
    expect(problems({ displayOrder: '10000' })).toEqual({ displayOrder: 'place' });
    expect(problems({ displayOrder: '0' })).toEqual({});
  });

  it('fills the form from a table and sends it trimmed', () => {
    const one = tableOf(floor(), TABLE_1)!;
    expect(tableFormOf(one)).toEqual({
      label: '1',
      capacity: '4',
      sectionId: MAIN,
      displayOrder: '1',
    });
    expect(
      tableRequestOf(form({ label: ' Terrace 3 ', capacity: ' 6', displayOrder: '12 ' })),
    ).toEqual({ label: 'Terrace 3', capacity: 6, sectionId: MAIN, displayOrder: 12 });
  });
});
