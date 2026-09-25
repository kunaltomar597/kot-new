import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Badge, Tabs, type TabItem } from '../src/index.js';
import { expectNoAxeViolations, renderUi } from './render.js';

const items: TabItem[] = [
  { id: 'dine-in', label: 'Dine-in', content: 'Tables', badge: <Badge>3</Badge> },
  { id: 'takeaway', label: 'Takeaway', content: 'Parcels' },
  { id: 'delivery', label: 'Delivery', content: 'Riders', disabled: true },
  { id: 'qr', label: 'QR', content: 'QR orders' },
];

describe('[NFR-U01] Tabs', () => {
  it('selects the first enabled tab and renders only its panel', () => {
    renderUi(<Tabs label="Order type" items={items} />);
    expect(screen.getByRole('tablist', { name: 'Order type' })).toBeInTheDocument();
    const tab = screen.getByRole('tab', { name: 'Dine-in 3' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(tab).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tabpanel', { name: 'Dine-in 3' })).toHaveTextContent('Tables');
    expect(screen.queryByText('Parcels')).not.toBeInTheDocument();
  });

  it('moves with arrow keys, wraps, skips disabled tabs and supports Home/End', async () => {
    const onValueChange = vi.fn();
    const { user } = renderUi(
      <Tabs label="Order type" items={items} onValueChange={onValueChange} />,
    );
    await user.tab();
    expect(screen.getByRole('tab', { name: 'Dine-in 3' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Takeaway' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'QR' })).toHaveFocus();
    expect(screen.getByText('QR orders')).toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Dine-in 3' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'QR' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Dine-in 3' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'QR' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(onValueChange.mock.calls.map(([id]) => id as string)).toEqual([
      'takeaway',
      'qr',
      'dine-in',
      'qr',
      'dine-in',
      'qr',
    ]);
  });

  it('can be controlled and selected by tap', async () => {
    const onValueChange = vi.fn();
    const { user } = renderUi(
      <Tabs
        label="Order type"
        items={items}
        value="takeaway"
        onValueChange={onValueChange}
        fullWidth
      />,
    );
    expect(screen.getByText('Parcels')).toBeInTheDocument();
    await user.pointer({ keys: '[TouchA]', target: screen.getByRole('tab', { name: 'QR' }) });
    expect(onValueChange).toHaveBeenCalledWith('qr');
    // Controlled: stays on the given value until the parent changes it.
    expect(screen.getByText('Parcels')).toBeInTheDocument();
  });

  it('honours defaultValue and has no axe violations', async () => {
    const { container } = renderUi(<Tabs label="Order type" items={items} defaultValue="qr" />);
    expect(screen.getByText('QR orders')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
