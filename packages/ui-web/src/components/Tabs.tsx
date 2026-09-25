import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';
import { cx } from '../internal/cx.js';

export interface TabItem {
  readonly id: string;
  readonly label: ReactNode;
  readonly content: ReactNode;
  readonly disabled?: boolean;
  /** Extra content after the label, e.g. a Badge with a count. */
  readonly badge?: ReactNode;
}

export interface TabsProps {
  items: readonly TabItem[];
  /** Accessible name of the tab list, e.g. "Order sources". */
  label: string;
  /** Controlled selected tab id. */
  value?: string;
  /** Initially selected tab id when uncontrolled; defaults to the first enabled tab. */
  defaultValue?: string;
  onValueChange?: (id: string) => void;
  /** Stretch tabs to fill the row (touch layouts). */
  fullWidth?: boolean;
  className?: string;
}

/**
 * WAI-ARIA tabs: one tab stop, arrow keys (and Home/End) move between tabs and select them, and
 * only the selected panel is rendered.
 */
export function Tabs({
  items,
  label,
  value,
  defaultValue,
  onValueChange,
  fullWidth = false,
  className,
}: TabsProps) {
  const baseId = useId();
  const firstEnabled = items.find((item) => !item.disabled)?.id;
  const [internal, setInternal] = useState(defaultValue ?? firstEnabled);
  const selected = value ?? internal;
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const select = (id: string) => {
    if (value === undefined) setInternal(id);
    onValueChange?.(id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const enabled = items.filter((item) => !item.disabled);
    const index = enabled.findIndex((item) => item.id === selected);
    const last = enabled.length - 1;
    const target = {
      ArrowRight: index >= last ? 0 : index + 1,
      ArrowLeft: index <= 0 ? last : index - 1,
      Home: 0,
      End: last,
    }[event.key];
    const next = target === undefined ? undefined : enabled[target];
    if (!next) return;
    event.preventDefault();
    select(next.id);
    tabRefs.current.get(next.id)?.focus();
  };

  return (
    <div className={cx('rp-tabs', className)}>
      <div
        role="tablist"
        aria-label={label}
        className="rp-tabs__list"
        data-full-width={fullWidth || undefined}
      >
        {items.map((item) => {
          const isSelected = item.id === selected;
          return (
            <button
              key={item.id}
              ref={(element) => {
                if (element) tabRefs.current.set(item.id, element);
                else tabRefs.current.delete(item.id);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${item.id}`}
              aria-selected={isSelected}
              aria-controls={`${baseId}-panel-${item.id}`}
              tabIndex={isSelected ? 0 : -1}
              disabled={item.disabled}
              className="rp-tabs__tab"
              onKeyDown={onKeyDown}
              onClick={() => {
                select(item.id);
              }}
            >
              {item.label}
              {/* The space keeps the accessible name readable ("Dine-in 3", not "Dine-in3"). */}
              {item.badge ? <> {item.badge}</> : null}
            </button>
          );
        })}
      </div>
      {items.map((item) => (
        <div
          key={item.id}
          role="tabpanel"
          id={`${baseId}-panel-${item.id}`}
          aria-labelledby={`${baseId}-tab-${item.id}`}
          hidden={item.id !== selected}
          tabIndex={0}
          className="rp-tabs__panel"
        >
          {item.id === selected ? item.content : null}
        </div>
      ))}
    </div>
  );
}
