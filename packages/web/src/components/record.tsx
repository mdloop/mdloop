import { Fragment } from 'react';
import type { JSX, ReactNode } from 'react';

export interface RecordItem {
  label: string;
  value: ReactNode;
}

export interface RecordProps {
  items: RecordItem[];
}

/**
 * The hairline key/value ledger — generalizes the former
 * `.admin-detail-grid` `<dl>` pattern (org overview, subscription summary)
 * into a shared primitive. Two-column `dt`/`dd` grid at rest; stacks to
 * label-over-value below 720px (`docs/design-system.md` responsive table).
 */
export function Record({ items }: RecordProps): JSX.Element {
  return (
    <dl className="record">
      {items.map((item) => (
        <Fragment key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
