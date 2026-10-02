/**
 * The floor plan (ONB-004 step 5, S): each section is drawn on a grid of PLAN_COLUMNS × PLAN_ROWS
 * cells and each table is a rectangle or a round table on it, placed by dragging. Tables of one
 * section may not overlap; a table not yet placed is put in the first free spot, row by row.
 */

export const PLAN_COLUMNS = 40;
export const PLAN_ROWS = 24;
export const TABLE_SHAPES = ['RECT', 'ROUND'] as const;
export type TableShape = (typeof TABLE_SHAPES)[number];

/** Where a table sits on its section's plan, in grid cells. */
export interface TablePlace {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly shape: TableShape;
}

/** The smallest and largest a table may be drawn, in cells. */
export const TABLE_SIZE = { min: 2, max: 10 } as const;

export function fitsPlan(place: TablePlace): boolean {
  return (
    Number.isInteger(place.x) &&
    Number.isInteger(place.y) &&
    place.x >= 0 &&
    place.y >= 0 &&
    place.w >= TABLE_SIZE.min &&
    place.h >= TABLE_SIZE.min &&
    place.w <= TABLE_SIZE.max &&
    place.h <= TABLE_SIZE.max &&
    place.x + place.w <= PLAN_COLUMNS &&
    place.y + place.h <= PLAN_ROWS
  );
}

export function placesOverlap(a: TablePlace, b: TablePlace): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** The first pair of tables that overlap, by id, or undefined when none do. */
export function firstOverlap(
  tables: readonly { readonly id: string; readonly place: TablePlace }[],
): readonly [string, string] | undefined {
  for (const [index, table] of tables.entries()) {
    for (const other of tables.slice(index + 1)) {
      if (placesOverlap(table.place, other.place)) return [table.id, other.id];
    }
  }
  return undefined;
}

/** A table's size on the plan for its seats: bigger tables are drawn bigger. */
export function sizeForSeats(capacity: number): { w: number; h: number } {
  if (capacity <= 2) return { w: 3, h: 3 };
  if (capacity <= 4) return { w: 4, h: 3 };
  if (capacity <= 6) return { w: 5, h: 3 };
  return { w: 6, h: 4 };
}

/**
 * Every table's place: the ones placed keep theirs; the others go to the first free spot, row by
 * row, with a size for their seats (or the smallest that fits). A table with no room left is
 * left out, so the plan shows it in a list instead.
 */
export function placeTables(
  tables: readonly {
    readonly id: string;
    readonly capacity: number;
    readonly place: TablePlace | null;
  }[],
): Map<string, TablePlace> {
  const placed = new Map<string, TablePlace>();
  for (const table of tables) {
    if (table.place !== null && fitsPlan(table.place)) placed.set(table.id, table.place);
  }
  const free = (place: TablePlace) =>
    fitsPlan(place) && [...placed.values()].every((other) => !placesOverlap(place, other));
  for (const table of tables) {
    if (placed.has(table.id)) continue;
    const sizes = [sizeForSeats(table.capacity), { w: TABLE_SIZE.min, h: TABLE_SIZE.min }];
    search: for (const { w, h } of sizes) {
      // One empty cell around each table, so they can be told apart and dragged.
      for (let y = 1; y + h <= PLAN_ROWS; y += 1) {
        for (let x = 1; x + w <= PLAN_COLUMNS; x += 1) {
          const place: TablePlace = { x, y, w, h, shape: 'RECT' };
          const padded = { x: x - 1, y: y - 1, w: w + 2, h: h + 2, shape: 'RECT' } as const;
          if (free(place) && [...placed.values()].every((other) => !placesOverlap(padded, other))) {
            placed.set(table.id, place);
            break search;
          }
        }
      }
    }
  }
  return placed;
}

/** A place moved by whole cells, kept on the plan. */
export function movePlace(place: TablePlace, dx: number, dy: number): TablePlace {
  return {
    ...place,
    x: Math.min(Math.max(place.x + dx, 0), PLAN_COLUMNS - place.w),
    y: Math.min(Math.max(place.y + dy, 0), PLAN_ROWS - place.h),
  };
}

/** A place resized by whole cells, within the sizes allowed and the plan. */
export function resizePlace(place: TablePlace, dw: number, dh: number): TablePlace {
  const w = Math.min(
    Math.max(place.w + dw, TABLE_SIZE.min),
    TABLE_SIZE.max,
    PLAN_COLUMNS - place.x,
  );
  const h = Math.min(Math.max(place.h + dh, TABLE_SIZE.min), TABLE_SIZE.max, PLAN_ROWS - place.y);
  return { ...place, w, h };
}
