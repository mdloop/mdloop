import type { JSX, ReactNode } from 'react';
import { useMediaQuery } from '../use-media-query.js';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Hidden at the 900–1079px tablet-landscape band (sheds the lowest-value
   *  column rather than compressing everything — `docs/design-system.md`
   *  responsive table). Ignored in the below-720px stacked layout, where
   *  every column still shows per row. */
  shed?: boolean;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  /** Accessible name for the table/list (visually hidden). */
  caption: string;
  emptyState: ReactNode;
}

/**
 * Header row + rows + empty-state slot, for genuinely tabular content
 * (members, invoices, audit log — later sub-phases). Below 720px each row
 * collapses to a stacked label/value block instead of a horizontally
 * scrolling table; where a table does scroll (900–1079px, shed columns
 * aside) it scrolls inside `.data-table-scroll`, never the page body.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  caption,
  emptyState,
}: DataTableProps<T>): JSX.Element {
  const stacked = useMediaQuery('(max-width: 720px)');

  if (rows.length === 0) {
    return (
      <div className="data-table-empty" data-testid="data-table-empty">
        {emptyState}
      </div>
    );
  }

  if (stacked) {
    return (
      <ul className="data-table-stack" aria-label={caption} data-testid="data-table-stack">
        {rows.map((row) => (
          <li key={getRowKey(row)} className="data-table-stack-row">
            {columns.map((col) => (
              <div key={col.key} className="data-table-stack-cell">
                <span className="data-table-stack-label">{col.header}</span>
                <span className="data-table-stack-value">{col.render(row)}</span>
              </div>
            ))}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="data-table-scroll">
      <table className="data-table" aria-label={caption} data-testid="data-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={col.shed ? 'data-table-col--shed' : undefined}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getRowKey(row)}>
              {columns.map((col) => (
                <td key={col.key} className={col.shed ? 'data-table-col--shed' : undefined}>
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
