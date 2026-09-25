import type { ReactNode } from 'react';
import { cx } from '../internal/cx.js';

export interface TableColumn<Row> {
  readonly key: string;
  readonly header: ReactNode;
  readonly cell: (row: Row) => ReactNode;
  /** `end` for numbers and money so digits line up. */
  readonly align?: 'start' | 'center' | 'end';
  readonly width?: string;
}

export interface TableProps<Row> {
  /** Describes the table for screen readers; visible unless `hideCaption`. */
  caption: ReactNode;
  hideCaption?: boolean;
  columns: readonly TableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** Shown instead of the body when there are no rows (e.g. an EmptyState). */
  empty?: ReactNode;
  /** Rows at the bottom for totals. */
  footer?: ReactNode;
  className?: string;
}

/** A semantic data table with a caption, header cells and optional empty state. */
export function Table<Row>({
  caption,
  hideCaption = false,
  columns,
  rows,
  rowKey,
  empty,
  footer,
  className,
}: TableProps<Row>) {
  return (
    <div className={cx('rp-table-wrap', className)}>
      <table className="rp-table">
        <caption className={hideCaption ? 'rp-visually-hidden' : 'rp-table__caption'}>
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                data-align={column.align ?? 'start'}
                style={column.width ? { width: column.width } : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && empty ? (
            <tr>
              <td colSpan={columns.length} className="rp-table__empty">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((column) => (
                  <td key={column.key} data-align={column.align ?? 'start'}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  );
}
