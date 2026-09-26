import type { Tone } from '@rp/design-tokens';
import { formatRupees, type Paise, type TableState } from '@rp/domain';
import { cx } from '../internal/cx.js';
import { Icon, type IconName } from './Icon.js';
import { Money } from './Money.js';

/**
 * How each table state looks on every floor view (POS, waiter app): a tone and an icon next to the
 * state's name, so colour is never the only signal (NFR-U05).
 */
export const TABLE_STATE_STYLES: Readonly<
  Record<TableState, { readonly tone: Tone; readonly icon: IconName }>
> = {
  FREE: { tone: 'success', icon: 'check' },
  OCCUPIED: { tone: 'info', icon: 'users' },
  BILL_REQUESTED: { tone: 'warning', icon: 'bell' },
  BILL_PRINTED: { tone: 'neutral', icon: 'receipt' },
};

export interface TableTileProps {
  /** The table's label, e.g. "T4" or "Terrace 2". */
  label: string;
  state: TableState;
  /** The state's name from the i18n catalogue, e.g. "Occupied". */
  stateLabel: string;
  /** Short facts under the label, already worded by the app, e.g. "4 guests", "25 min", "Ravi". */
  details?: readonly string[];
  /** Billable amount so far (TBL-007); omitted for a free table. */
  amountSoFar?: Paise;
  /** Something waiting for staff (approvals, service requests), e.g. "2 to approve". */
  alert?: string;
  selected?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  className?: string;
}

/**
 * One table on the live floor (TBL-007): a large touch target (NFR-U03) with its label, state,
 * guests, time seated, waiter and amount so far. It is a button whose accessible name reads the
 * same facts in order, separated so a screen reader pauses between them.
 */
export function TableTile({
  label,
  state,
  stateLabel,
  details = [],
  amountSoFar,
  alert,
  selected = false,
  disabled = false,
  onSelect,
  className,
}: TableTileProps) {
  const style = TABLE_STATE_STYLES[state];
  const spoken = [
    label,
    stateLabel,
    ...details,
    ...(amountSoFar === undefined ? [] : [formatRupees(amountSoFar)]),
    ...(alert === undefined ? [] : [alert]),
  ];
  return (
    <button
      type="button"
      aria-label={spoken.join(', ')}
      data-tone={style.tone}
      data-state={state}
      aria-pressed={onSelect === undefined ? undefined : selected}
      disabled={disabled}
      onClick={onSelect}
      className={cx('rp-table-tile', className)}
    >
      <span className="rp-table-tile__label">{label}</span>
      <span className="rp-table-tile__state">
        <Icon name={style.icon} />
        {stateLabel}
      </span>
      {details.length > 0 ? (
        <span className="rp-table-tile__details">
          {details.map((detail) => (
            <span key={detail} className="rp-table-tile__detail">
              {detail}
            </span>
          ))}
        </span>
      ) : null}
      {amountSoFar === undefined ? null : (
        <Money paise={amountSoFar} strong className="rp-table-tile__amount" />
      )}
      {alert === undefined ? null : (
        <span className="rp-table-tile__alert">
          <Icon name="bell" />
          {alert}
        </span>
      )}
    </button>
  );
}
