import type {
  FloorResponse,
  SectionRequest,
  SectionView,
  TableLayout,
  TableRequest,
  TableView,
} from '@rp/contracts';
import { firstOverlap, placeTables, type TablePlace } from '@rp/domain';

/** What the section form holds, as typed. */
export interface SectionDraft {
  readonly name: string;
  readonly displayOrder: string;
}

/** What the table form holds, as typed. */
export interface TableDraft {
  readonly label: string;
  readonly capacity: string;
  readonly sectionId: string;
  readonly displayOrder: string;
}

export type FloorProblem =
  'nameRequired' | 'labelRequired' | 'capacityInvalid' | 'sectionRequired' | 'orderInvalid';

const isOrder = (text: string) => /^\d{1,4}$/.test(text.trim());

export function sectionDraftOf(section: SectionView | undefined, next: number): SectionDraft {
  return {
    name: section?.name ?? '',
    displayOrder: String(section?.displayOrder ?? next),
  };
}

export function sectionRequestOf(draft: SectionDraft): SectionRequest | FloorProblem[] {
  const problems: FloorProblem[] = [];
  const name = draft.name.trim();
  if (name === '' || name.length > 40) problems.push('nameRequired');
  if (!isOrder(draft.displayOrder)) problems.push('orderInvalid');
  return problems.length > 0 ? problems : { name, displayOrder: Number(draft.displayOrder) };
}

export function tableDraftOf(
  table: TableView | undefined,
  sectionId: string,
  next: number,
): TableDraft {
  return {
    label: table?.label ?? '',
    capacity: String(table?.capacity ?? 4),
    sectionId: table?.sectionId ?? sectionId,
    displayOrder: String(table?.displayOrder ?? next),
  };
}

export function tableRequestOf(draft: TableDraft): TableRequest | FloorProblem[] {
  const problems: FloorProblem[] = [];
  const label = draft.label.trim();
  if (label === '' || label.length > 20) problems.push('labelRequired');
  const capacity = draft.capacity.trim();
  if (!/^\d{1,2}$/.test(capacity) || Number(capacity) < 1 || Number(capacity) > 50) {
    problems.push('capacityInvalid');
  }
  if (draft.sectionId === '') problems.push('sectionRequired');
  if (!isOrder(draft.displayOrder)) problems.push('orderInvalid');
  return problems.length > 0
    ? problems
    : {
        label,
        capacity: Number(capacity),
        sectionId: draft.sectionId,
        displayOrder: Number(draft.displayOrder),
      };
}

/** The position after the last one, for a new section or table. */
export function nextOrder(entries: readonly { readonly displayOrder: number }[]): number {
  return Math.min(Math.max(-1, ...entries.map((entry) => entry.displayOrder)) + 1, 9_999);
}

export function activeSections(floor: FloorResponse): SectionView[] {
  return floor.sections.filter((section) => section.archivedAt === null);
}

export function activeTables(section: SectionView): TableView[] {
  return section.tables.filter((table) => table.archivedAt === null);
}

/**
 * Where every active table of a section is drawn: its saved place, or the first free spot for a
 * table not placed yet. Tables with no room left are not drawn (`unplaced`).
 */
export function planOf(
  section: SectionView,
  edited: ReadonlyMap<string, TablePlace> = new Map(),
): { places: Map<string, TablePlace>; unplaced: TableView[] } {
  const tables = activeTables(section);
  const places = placeTables(
    tables.map((table) => ({
      id: table.id,
      capacity: table.capacity,
      place: edited.get(table.id) ?? table.layout,
    })),
  );
  return { places, unplaced: tables.filter((table) => !places.has(table.id)) };
}

/** The tables whose drawn place differs from the saved one: what Save plan sends. */
export function layoutChanges(
  floor: FloorResponse,
  edited: ReadonlyMap<string, TablePlace>,
): { tableId: string; layout: TableLayout }[] {
  return activeSections(floor).flatMap((section) => {
    const { places } = planOf(section, edited);
    return activeTables(section).flatMap((table) => {
      const place = places.get(table.id);
      if (place === undefined || JSON.stringify(place) === JSON.stringify(table.layout)) return [];
      return [{ tableId: table.id, layout: { ...place } }];
    });
  });
}

/** The first two tables drawn on top of each other in a section, by label. */
export function overlapIn(
  section: SectionView,
  edited: ReadonlyMap<string, TablePlace>,
): readonly [string, string] | undefined {
  const { places } = planOf(section, edited);
  const clash = firstOverlap([...places].map(([id, place]) => ({ id, place })));
  if (clash === undefined) return undefined;
  const label = (id: string) => section.tables.find((table) => table.id === id)?.label ?? id;
  return [label(clash[0]), label(clash[1])];
}
