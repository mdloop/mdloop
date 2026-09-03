import type { JSX } from 'react';

export interface MeterProps {
  label: string;
  value: number;
  /** `null` means unlimited — renders an honest "Unlimited" row with no bar,
   *  rather than a bar that can never fill. */
  ceiling: number | null;
  /** Applied to both `value` and `ceiling` independently — e.g. `humanBytes`
   *  for a storage meter. Defaults to locale-formatted integers. */
  formatter?: (n: number) => string;
}

function defaultFormatter(n: number): string {
  return n.toLocaleString();
}

/**
 * The system's signature usage lane (`docs/design-system.md` "Signature: the
 * usage lane") — the 3px document-row rail turned horizontal into a quota
 * meter: a hairline track, a filled lane, a mono numeral pair. Fill stays a
 * quiet neutral until >=80% of ceiling, where it crosses to amber `--signal`
 * — "a human should look at this" — and stays amber (never `--danger` red,
 * which this system reserves for destruction) at and past the ceiling, where
 * it also gains an "At limit" label instead of "Approaching limit".
 */
export function Meter({
  label,
  value,
  ceiling,
  formatter = defaultFormatter,
}: MeterProps): JSX.Element {
  const unlimited = ceiling === null;
  const pct = unlimited ? 0 : ceiling <= 0 ? 100 : Math.min(100, (value / ceiling) * 100);
  const atLimit = !unlimited && pct >= 100;
  const approaching = !unlimited && !atLimit && pct >= 80;
  const flagged = atLimit || approaching;

  return (
    <div className={`meter${flagged ? ' meter--signal' : ''}`} data-testid="meter">
      <div className="meter-label">{label}</div>
      <div className="meter-row">
        {!unlimited && (
          <div
            className="meter-track"
            role="progressbar"
            aria-valuenow={Math.round(value)}
            aria-valuemin={0}
            aria-valuemax={ceiling}
            aria-valuetext={`${formatter(value)} of ${formatter(ceiling)}`}
          >
            <div className="meter-fill" style={{ width: `${String(pct)}%` }} />
          </div>
        )}
        <div className="meter-numerals">
          {unlimited ? (
            <span className="meter-unlimited">Unlimited</span>
          ) : (
            <span>
              {formatter(value)} / {formatter(ceiling)}
            </span>
          )}
        </div>
      </div>
      {flagged && <span className="meter-flag">{atLimit ? 'At limit' : 'Approaching limit'}</span>}
    </div>
  );
}
