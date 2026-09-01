import type { ReactNode } from 'react';
import { useT } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import styles from './Table.module.css';

export interface TableColumn<Row> {
  id: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  /** Any CSS length; applied to a `<col>` so the header and body agree. */
  width?: string;
  /** Logical alignment. `end` is the right edge in English and the left edge in Persian. */
  align?: 'start' | 'end';
  /** ASCII, monospace, LTR-isolated: byte sizes, addresses, timestamps. */
  latin?: boolean;
}

export interface TableProps<Row> {
  columns: readonly TableColumn<Row>[];
  rows: readonly Row[];
  getRowId: (row: Row) => string;
  /** Accessible description of the table; rendered above it in a muted tone. */
  caption?: ReactNode;
  empty?: ReactNode;
  onRowClick?: (row: Row) => void;
  selectedRowId?: string | null;
  dense?: boolean;
  className?: string;
}

/**
 * A data table with the canvas's column-header treatment.
 *
 * A real `<table>`, not a grid of divs: the header association, the row/column counts and
 * the reading order come free, and a screen reader can navigate cell by cell. Row clicks
 * are wired to both `onClick` and Enter/Space so the row is not a mouse-only affordance.
 */
export function Table<Row>({
  columns,
  rows,
  getRowId,
  caption,
  empty,
  onRowClick,
  selectedRowId,
  dense = false,
  className,
}: TableProps<Row>) {
  const t = useT();

  return (
    <div className={cx(styles.scroll, className)}>
      <table className={cx(styles.table, dense ? styles.dense : undefined)}>
        {caption ? <caption className={styles.caption}>{caption}</caption> : null}
        <colgroup>
          {columns.map((column) => (
            <col key={column.id} style={column.width ? { width: column.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={cx(styles.th, column.align === 'end' ? styles.alignEnd : undefined)}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className={cx(styles.td, styles.emptyCell)} colSpan={columns.length}>
                {empty ?? <div className={styles.emptyBody}>{t('table.empty')}</div>}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const id = getRowId(row);
              const selected = selectedRowId === id;
              return (
                <tr
                  key={id}
                  className={cx(
                    styles.row,
                    onRowClick ? styles.clickable : undefined,
                    selected ? styles.selected : undefined,
                  )}
                  aria-selected={selectedRowId !== undefined ? selected : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                >
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={cx(
                        styles.td,
                        column.align === 'end' ? styles.alignEnd : undefined,
                        column.latin ? styles.latin : undefined,
                      )}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
