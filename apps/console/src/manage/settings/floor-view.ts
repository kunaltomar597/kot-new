import {
  type FloorResponse,
  SectionRequest,
  type SectionView,
  TableRequest,
  type TableView,
} from '@rp/contracts';

/**
 * The Floor page's logic (P4-03d, TBL-001, ONB-004 step 5), without React: the sections and their
 * tables as the page lists them, and the section and table forms with the same checks as the
 * server, so it rarely has to refuse anything.
 */

const SECTION_PLACE_MAX = 999;
const TABLE_PLACE_MAX = 9_999;
const CAPACITY_MAX = 50;
/** Seats a new table is laid for until the manager says otherwise (the database's default). */
const DEFAULT_CAPACITY = 4;

const isActive = (entry: { readonly archivedAt: string | null }) => entry.archivedAt === null;

/** Names and labels compared as people read them: spaces around and letter case do not count. */
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A whole number typed in a field, within bounds; undefined otherwise. */
function wholeNumber(text: string, min: number, max: number): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : undefined;
}

/** A section as the page lists it: its tables, and the tables and seats in use. */
export interface FloorSection {
  readonly section: SectionView;
  /** In the server's order (place, then age); archived ones only when asked for. */
  readonly tables: readonly TableView[];
  /** Active tables and the seats they are laid for. */
  readonly tableCount: number;
  readonly seats: number;
}

/** The sections in the server's order with their tables; archived ones only when asked for. */
export function floorSections(
  floor: FloorResponse,
  options: { readonly archived: boolean },
): FloorSection[] {
  return floor.sections
    .filter((section) => options.archived || isActive(section))
    .map((section) => {
      const active = section.tables.filter(isActive);
      return {
        section,
        tables: options.archived ? section.tables : active,
        tableCount: active.length,
        seats: active.reduce((total, table) => total + table.capacity, 0),
      };
    });
}

/** The sections a table can be put in. */
export function activeSections(floor: FloorResponse): SectionView[] {
  return floor.sections.filter(isActive);
}

export function tableOf(floor: FloorResponse, tableId: string): TableView | undefined {
  return floor.sections.flatMap((section) => section.tables).find((table) => table.id === tableId);
}

// ---------------------------------------------------------------- sections

export interface SectionForm {
  readonly name: string;
  readonly displayOrder: string;
}

export type SectionField = 'name' | 'displayOrder';
export type SectionProblem = 'nameRequired' | 'nameTaken' | 'place';

/** A new section goes after the others. */
export function emptySectionForm(floor: FloorResponse): SectionForm {
  const last = Math.max(0, ...floor.sections.map((section) => section.displayOrder));
  return { name: '', displayOrder: String(Math.min(last + 1, SECTION_PLACE_MAX)) };
}

export function sectionFormOf(section: SectionView): SectionForm {
  return { name: section.name, displayOrder: String(section.displayOrder) };
}

/** The server's checks: a name no other active section has (floor screens show it), a place. */
export function checkSection(
  form: SectionForm,
  floor: FloorResponse,
  selfId: string | undefined,
): Partial<Record<SectionField, SectionProblem>> {
  const problems: Partial<Record<SectionField, SectionProblem>> = {};
  if (!SectionRequest.shape.name.safeParse(form.name).success) {
    problems.name = 'nameRequired';
  } else if (
    floor.sections.some(
      (section) => isActive(section) && section.id !== selfId && sameName(section.name, form.name),
    )
  ) {
    problems.name = 'nameTaken';
  }
  if (wholeNumber(form.displayOrder, 0, SECTION_PLACE_MAX) === undefined) {
    problems.displayOrder = 'place';
  }
  return problems;
}

/** The request for a checked form. */
export function sectionRequestOf(form: SectionForm): SectionRequest {
  return { name: form.name.trim(), displayOrder: Number(form.displayOrder.trim()) };
}

// ---------------------------------------------------------------- tables

export interface TableForm {
  readonly label: string;
  readonly capacity: string;
  /** Empty until chosen. */
  readonly sectionId: string;
  readonly displayOrder: string;
}

export type TableField = 'label' | 'capacity' | 'sectionId' | 'displayOrder';
export type TableProblem =
  'labelRequired' | 'labelTaken' | 'labelArchived' | 'capacity' | 'sectionMissing' | 'place';

/** The place after the last table of a section, archived ones included, so it goes last. */
export function nextTablePlace(floor: FloorResponse, sectionId: string): number {
  const section = floor.sections.find((entry) => entry.id === sectionId);
  const last = Math.max(0, ...(section?.tables ?? []).map((table) => table.displayOrder));
  return Math.min(last + 1, TABLE_PLACE_MAX);
}

/** A new table in a section (or in none yet), laid for four, after the section's tables. */
export function emptyTableForm(floor: FloorResponse, sectionId: string | undefined): TableForm {
  const chosen =
    sectionId !== undefined && activeSections(floor).some((section) => section.id === sectionId)
      ? sectionId
      : '';
  return {
    label: '',
    capacity: String(DEFAULT_CAPACITY),
    sectionId: chosen,
    displayOrder: String(chosen === '' ? 1 : nextTablePlace(floor, chosen)),
  };
}

export function tableFormOf(table: TableView): TableForm {
  return {
    label: table.label,
    capacity: String(table.capacity),
    sectionId: table.sectionId,
    displayOrder: String(table.displayOrder),
  };
}

/**
 * The server's checks: a label no other table has, archived ones included (labels name tables on
 * old tickets and bills), the seats, an active section and a place.
 */
export function checkTable(
  form: TableForm,
  floor: FloorResponse,
  selfId: string | undefined,
): Partial<Record<TableField, TableProblem>> {
  const problems: Partial<Record<TableField, TableProblem>> = {};
  if (!TableRequest.shape.label.safeParse(form.label).success) {
    problems.label = 'labelRequired';
  } else {
    const clash = floor.sections
      .flatMap((section) => section.tables)
      .find((table) => table.id !== selfId && sameName(table.label, form.label));
    if (clash !== undefined) problems.label = isActive(clash) ? 'labelTaken' : 'labelArchived';
  }
  if (wholeNumber(form.capacity, 1, CAPACITY_MAX) === undefined) problems.capacity = 'capacity';
  if (!activeSections(floor).some((section) => section.id === form.sectionId)) {
    problems.sectionId = 'sectionMissing';
  }
  if (wholeNumber(form.displayOrder, 0, TABLE_PLACE_MAX) === undefined) {
    problems.displayOrder = 'place';
  }
  return problems;
}

/** The request for a checked form. */
export function tableRequestOf(form: TableForm): TableRequest {
  return {
    label: form.label.trim(),
    capacity: Number(form.capacity.trim()),
    sectionId: form.sectionId,
    displayOrder: Number(form.displayOrder.trim()),
  };
}
