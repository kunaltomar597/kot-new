import { TABLE_STATES } from '@rp/domain';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ICON_NAMES, TABLE_STATE_STYLES, TableTile } from '../src/index.js';
import { expectNoAxeViolations, renderUi } from './render.js';

describe('[TBL-007] [NFR-U05] TableTile', () => {
  it('has a tone and a distinct icon for every table state', () => {
    expect(Object.keys(TABLE_STATE_STYLES).sort()).toEqual([...TABLE_STATES].sort());
    const icons = Object.values(TABLE_STATE_STYLES).map((style) => style.icon);
    expect(new Set(icons).size).toBe(icons.length);
    for (const icon of icons) expect(ICON_NAMES).toContain(icon);
  });

  it('shows the label, state, details, amount and alert, and is one button', async () => {
    const onSelect = vi.fn();
    const { user, container } = renderUi(
      <TableTile
        label="T4"
        state="OCCUPIED"
        stateLabel="Occupied"
        details={['4 guests', '25 min', 'Ravi']}
        amountSoFar={123_450}
        alert="2 to approve"
        onSelect={onSelect}
      />,
    );
    const tile = screen.getByRole('button', {
      name: 'T4, Occupied, 4 guests, 25 min, Ravi, ₹1,234.50, 2 to approve',
    });
    expect(tile).toHaveAttribute('data-state', 'OCCUPIED');
    expect(tile).toHaveAttribute('aria-pressed', 'false');
    expect(tile).toHaveTextContent('₹1,234.50');
    expect(tile).toHaveTextContent('2 to approve');
    await user.click(tile);
    expect(onSelect).toHaveBeenCalledOnce();
    await expectNoAxeViolations(container);
  });

  it('shows a free table without amount, and can be disabled', () => {
    renderUi(<TableTile label="T1" state="FREE" stateLabel="Free" disabled />);
    const tile = screen.getByRole('button', { name: 'T1, Free' });
    expect(tile).toBeDisabled();
    expect(tile.querySelector('data')).toBeNull();
    expect(tile).not.toHaveAttribute('aria-pressed');
  });
});
