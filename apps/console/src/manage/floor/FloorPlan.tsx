import type { SectionView, TableView } from '@rp/contracts';
import { movePlace, PLAN_COLUMNS, PLAN_ROWS, resizePlace, type TablePlace } from '@rp/domain';
import { type KeyboardEvent, type PointerEvent, type ReactNode, useRef } from 'react';
import { useT } from '../../app/i18n.js';

/** Where a place sits on the board, as percentages, so the board can be any width. */
function boxOf(place: TablePlace) {
  return {
    left: `${String((place.x / PLAN_COLUMNS) * 100)}%`,
    top: `${String((place.y / PLAN_ROWS) * 100)}%`,
    width: `${String((place.w / PLAN_COLUMNS) * 100)}%`,
    height: `${String((place.h / PLAN_ROWS) * 100)}%`,
  };
}

/**
 * A section drawn as its floor plan (ONB-004 step 5): the grid, with each table where it stands.
 * `render` draws a table; the POS shows its state, the editor makes it draggable.
 */
export function PlanBoard({
  label,
  tables,
  places,
  render,
}: {
  label: string;
  tables: readonly TableView[];
  places: ReadonlyMap<string, TablePlace>;
  render: (table: TableView, place: TablePlace, style: ReturnType<typeof boxOf>) => ReactNode;
}) {
  return (
    <div className="floor-plan" role="group" aria-label={label}>
      {tables.map((table) => {
        const place = places.get(table.id);
        return place === undefined ? null : render(table, place, boxOf(place));
      })}
    </div>
  );
}

/**
 * The plan editor for one section: tables are dragged with a pointer, or moved with the arrow
 * keys (Shift to resize, R for round or square), always by whole cells and never off the plan.
 */
export function PlanEditor({
  section,
  places,
  onChange,
  onAnnounce,
}: {
  section: SectionView;
  places: ReadonlyMap<string, TablePlace>;
  onChange: (tableId: string, place: TablePlace) => void;
  /** What a keyboard move did, for screen readers. */
  onAnnounce: (message: string) => void;
}) {
  const t = useT();
  const board = useRef<HTMLDivElement>(null);
  const drag = useRef<
    { tableId: string; startX: number; startY: number; start: TablePlace } | undefined
  >(undefined);

  const describe = (table: TableView, place: TablePlace) =>
    t('floorPage.planEditor.table', {
      label: table.label,
      seats: t('floorPage.seats', { count: table.capacity }),
      x: place.x + 1,
      y: place.y + 1,
      w: place.w,
      h: place.h,
    });

  const begin = (event: PointerEvent<HTMLButtonElement>, table: TableView, place: TablePlace) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      tableId: table.id,
      startX: event.clientX,
      startY: event.clientY,
      start: place,
    };
  };
  const follow = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    const rect = board.current?.querySelector('.floor-plan')?.getBoundingClientRect();
    if (current === undefined || rect === undefined || rect.width === 0) return;
    const dx = Math.round((event.clientX - current.startX) / (rect.width / PLAN_COLUMNS));
    const dy = Math.round((event.clientY - current.startY) / (rect.height / PLAN_ROWS));
    onChange(current.tableId, movePlace(current.start, dx, dy));
  };
  const end = () => {
    drag.current = undefined;
  };

  const key = (event: KeyboardEvent<HTMLButtonElement>, table: TableView, place: TablePlace) => {
    const steps: Record<string, readonly [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const step = steps[event.key];
    let next: TablePlace | undefined;
    if (step !== undefined) {
      next = event.shiftKey
        ? resizePlace(place, step[0], step[1])
        : movePlace(place, step[0], step[1]);
    } else if (event.key === 'r' || event.key === 'R') {
      next = { ...place, shape: place.shape === 'ROUND' ? 'RECT' : 'ROUND' };
    }
    if (next === undefined) return;
    event.preventDefault();
    onChange(table.id, next);
    onAnnounce(
      event.shiftKey
        ? t('floorPage.planEditor.resized', { label: table.label, w: next.w, h: next.h })
        : t('floorPage.planEditor.moved', { label: table.label, x: next.x + 1, y: next.y + 1 }),
    );
  };

  return (
    <div ref={board}>
      <PlanBoard
        label={t('floorPage.planEditor.section', { name: section.name })}
        tables={section.tables.filter((table) => table.archivedAt === null)}
        places={places}
        render={(table, place, style) => (
          <button
            key={table.id}
            type="button"
            className={
              place.shape === 'ROUND'
                ? 'floor-plan__table floor-plan__table--round'
                : 'floor-plan__table'
            }
            style={style}
            aria-label={describe(table, place)}
            onPointerDown={(event) => {
              begin(event, table, place);
            }}
            onPointerMove={follow}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={(event) => {
              key(event, table, place);
            }}
          >
            {table.label}
          </button>
        )}
      />
    </div>
  );
}
