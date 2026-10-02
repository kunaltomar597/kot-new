import { describe, expect, it } from 'vitest';
import {
  firstOverlap,
  fitsPlan,
  movePlace,
  PLAN_COLUMNS,
  PLAN_ROWS,
  placesOverlap,
  placeTables,
  resizePlace,
  type TablePlace,
} from '../src/floor-plan.js';

const at = (x: number, y: number, w = 4, h = 3): TablePlace => ({ x, y, w, h, shape: 'RECT' });

describe('[ONB-004] the floor plan', () => {
  it('keeps tables on the plan, within the sizes allowed', () => {
    expect(fitsPlan(at(0, 0))).toBe(true);
    expect(fitsPlan(at(PLAN_COLUMNS - 4, PLAN_ROWS - 3))).toBe(true);
    expect(fitsPlan(at(PLAN_COLUMNS - 3, 0))).toBe(false);
    expect(fitsPlan(at(-1, 0))).toBe(false);
    expect(fitsPlan(at(0, 0, 1, 3))).toBe(false);
    expect(fitsPlan(at(0, 0, 11, 3))).toBe(false);
    expect(fitsPlan(at(0.5, 0))).toBe(false);
  });

  it('finds tables that overlap; touching edges is fine', () => {
    expect(placesOverlap(at(0, 0), at(3, 2))).toBe(true);
    expect(placesOverlap(at(0, 0), at(4, 0))).toBe(false);
    expect(placesOverlap(at(0, 0), at(0, 3))).toBe(false);
    expect(
      firstOverlap([
        { id: 'T1', place: at(0, 0) },
        { id: 'T2', place: at(5, 0) },
        { id: 'T3', place: at(6, 2) },
      ]),
    ).toEqual(['T2', 'T3']);
    expect(firstOverlap([{ id: 'T1', place: at(0, 0) }])).toBeUndefined();
  });

  it('places the tables not yet placed in free spots, sized for their seats', () => {
    const places = placeTables([
      { id: 'T1', capacity: 4, place: at(1, 1) },
      { id: 'T2', capacity: 2, place: null },
      { id: 'T3', capacity: 8, place: null },
    ]);
    expect(places.get('T1')).toEqual(at(1, 1));
    const t2 = places.get('T2');
    const t3 = places.get('T3');
    expect(t2).toMatchObject({ w: 3, h: 3, y: 1 });
    expect(t3).toMatchObject({ w: 6, h: 4 });
    const all = [...places.entries()].map(([id, place]) => ({ id, place }));
    expect(firstOverlap(all)).toBeUndefined();
    expect(all.every(({ place }) => fitsPlan(place))).toBe(true);
  });

  it('leaves out a table there is no room for', () => {
    const many = Array.from({ length: 200 }, (_, index) => ({
      id: `T${String(index)}`,
      capacity: 4,
      place: null,
    }));
    const places = placeTables(many);
    expect(places.size).toBeLessThan(200);
    expect(
      firstOverlap([...places.entries()].map(([id, place]) => ({ id, place }))),
    ).toBeUndefined();
  });

  it('moves and resizes by whole cells without leaving the plan', () => {
    expect(movePlace(at(0, 0), -1, 2)).toEqual(at(0, 2));
    expect(movePlace(at(PLAN_COLUMNS - 4, 0), 3, 0)).toEqual(at(PLAN_COLUMNS - 4, 0));
    expect(resizePlace(at(0, 0), 1, -5)).toEqual(at(0, 0, 5, 2));
    expect(resizePlace(at(PLAN_COLUMNS - 4, 0), 3, 0)).toEqual(at(PLAN_COLUMNS - 4, 0));
  });
});
