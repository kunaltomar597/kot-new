import { ORDER_ITEM_STATES } from '@rp/domain';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  Badge,
  Button,
  Card,
  CONNECTION_STATUSES,
  ConnectionBanner,
  EmptyState,
  ErrorState,
  ICON_NAMES,
  Icon,
  LoadingState,
  Money,
  ORDER_ITEM_STATE_STYLES,
  StatusChip,
  Table,
  ThemeRoot,
  useUiStrings,
} from '../src/index.js';
import { expectNoAxeViolations, renderUi } from './render.js';

describe('[NFR-M01] [NFR-U05] StatusChip', () => {
  it('has a tone and an icon for every order item state', () => {
    expect(Object.keys(ORDER_ITEM_STATE_STYLES).sort()).toEqual([...ORDER_ITEM_STATES].sort());
    for (const style of Object.values(ORDER_ITEM_STATE_STYLES)) {
      expect(ICON_NAMES).toContain(style.icon);
    }
  });

  it('shows the state name next to an icon, so colour is not the only signal', () => {
    const { container } = renderUi(<StatusChip state="READY" label="Ready" size="lg" />);
    const chip = screen.getByText('Ready');
    expect(chip).toHaveAttribute('data-tone', 'success');
    expect(chip).toHaveAttribute('data-state', 'READY');
    expect(container.querySelector('svg[data-icon="check"]')).toBeInTheDocument();
  });

  it('gives states in the same tone different icons', () => {
    const icons = ORDER_ITEM_STATES.map((state) => ORDER_ITEM_STATE_STYLES[state]);
    for (const a of icons) {
      const sameTone = icons.filter((b) => b.tone === a.tone && b.icon === a.icon);
      // Rejected and cancelled share a meaning (did not happen) and an icon; nothing else does.
      expect(sameTone.length).toBeLessThanOrEqual(2);
    }
  });
});

describe('[NFR-U04] state views', () => {
  it('EmptyState shows a title, what to do next and an action', async () => {
    const { container } = renderUi(
      <EmptyState
        title="No orders yet"
        description="New orders appear here."
        action={<Button>New order</Button>}
      />,
    );
    expect(screen.getByText('No orders yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New order' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('LoadingState is a polite status', () => {
    renderUi(<LoadingState title="Loading menu…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading menu…');
  });

  it('ErrorState is an alert with a retry button', async () => {
    const onRetry = vi.fn();
    const { user } = renderUi(
      <ErrorState
        title="Could not load tables"
        description="Check the server is running, then try again."
        onRetry={onRetry}
        retryLabel="Try again"
        action={<Button variant="ghost">Help</Button>}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load tables');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Help' })).toBeInTheDocument();
  });

  it('ErrorState without actions has no action row', () => {
    const { container } = renderUi(<ErrorState title="Failed" />);
    expect(container.querySelector('.rp-state__action')).toBeNull();
  });
});

describe('[NFR-U04] ConnectionBanner', () => {
  it('is hidden while online', () => {
    const { container } = renderUi(<ConnectionBanner status="online" message="Online" />);
    expect(container.querySelector('.rp-connection-banner')).toBeNull();
  });

  it('is a polite status while reconnecting and an alert when offline', () => {
    const { rerender } = renderUi(
      <ConnectionBanner status="reconnecting" message="Reconnecting to the server…" />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting to the server…');
    rerender(
      <ConnectionBanner
        status="offline"
        message="Can't reach the server. Orders are kept on this device."
        action={<Button size="md">Retry now</Button>}
      />,
    );
    expect(screen.getByRole('alert')).toHaveAttribute('data-tone', 'danger');
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeInTheDocument();
    expect(CONNECTION_STATUSES).toEqual(['online', 'reconnecting', 'offline']);
  });
});

describe('[NFR-L03] Money', () => {
  it('formats paise with @rp/domain and keeps the raw value', () => {
    renderUi(<Money paise={12345678} strong size="xl" />);
    const money = screen.getByText('₹1,23,456.78');
    expect(money.tagName).toBe('DATA');
    expect(money).toHaveAttribute('value', '12345678');
    expect(money).toHaveAttribute('data-strong', 'true');
  });

  it('hides the symbol and marks negatives when asked', () => {
    renderUi(<Money paise={-5050} symbol={false} signTone />);
    expect(screen.getByText('-50.50')).toHaveAttribute('data-negative', 'true');
  });

  it('refuses non-integer amounts (never floats)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderUi(<Money paise={10.5} />)).toThrow();
    vi.restoreAllMocks();
  });
});

describe('[NFR-U01] Card, Badge and Table', () => {
  it('Card renders title, actions, body and footer', async () => {
    const { container } = renderUi(
      <Card
        title="Table 4"
        headingLevel={2}
        actions={<Button variant="ghost">Edit</Button>}
        footer={<Button>Bill</Button>}
        variant="raised"
      >
        <p>4 covers</p>
      </Card>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Table 4' })).toBeInTheDocument();
    expect(screen.getByText('4 covers')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('Card without a title has no header', () => {
    const { container } = renderUi(<Card>Only body</Card>);
    expect(container.querySelector('.rp-card__header')).toBeNull();
  });

  it('Badge renders its text with tone and variant', () => {
    renderUi(
      <Badge tone="danger" variant="solid" icon={<Icon name="warning" />}>
        2 late
      </Badge>,
    );
    expect(screen.getByText('2 late')).toHaveAttribute('data-variant', 'solid');
  });

  const rows = [
    { id: 'a', name: 'Paneer tikka', qty: 2, paise: 58000 },
    { id: 'b', name: 'Masala dosa', qty: 1, paise: 18000 },
  ];
  const columns = [
    { key: 'name', header: 'Item', cell: (row: (typeof rows)[number]) => row.name },
    {
      key: 'qty',
      header: 'Qty',
      cell: (row: (typeof rows)[number]) => row.qty,
      align: 'center' as const,
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'end' as const,
      width: '8rem',
      cell: (row: (typeof rows)[number]) => <Money paise={row.paise} />,
    },
  ];

  it('Table has a caption, column headers and one row per item', async () => {
    const { container } = renderUi(
      <Table
        caption="Bill items"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        footer={
          <tr>
            <th scope="row" colSpan={2}>
              Total
            </th>
            <td data-align="end">
              <Money paise={76000} />
            </td>
          </tr>
        }
      />,
    );
    const table = screen.getByRole('table', { name: 'Bill items' });
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Item',
      'Qty',
      'Amount',
    ]);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(screen.getByText('₹580.00').closest('td')).toHaveAttribute('data-align', 'end');
    await expectNoAxeViolations(container);
  });

  it('Table shows the empty state when there are no rows', () => {
    renderUi(
      <Table
        caption="Bill items"
        hideCaption
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        empty={<EmptyState title="No items" />}
      />,
    );
    expect(screen.getByText('No items').closest('td')).toHaveAttribute('colspan', '3');
    expect(screen.getByText('Bill items')).toHaveClass('rp-visually-hidden');
  });
});

describe('[NFR-U02] ThemeRoot', () => {
  it('sets the theme and the restaurant accent with a readable text colour', () => {
    render(
      <ThemeRoot theme="dark" accent="#fde047" style={{ padding: 4 }} data-testid="root">
        x
      </ThemeRoot>,
    );
    const root = screen.getByTestId('root');
    expect(root).toHaveAttribute('data-theme', 'dark');
    expect(root.style.getPropertyValue('--rp-color-accent')).toBe('#fde047');
    expect(root.style.getPropertyValue('--rp-color-on-accent')).toBe('#000000');
    expect(root.style.padding).toBe('4px');
  });

  it('ignores an invalid accent instead of breaking the screen', () => {
    render(
      <ThemeRoot theme="light" accent="red; background: url(x)" data-testid="root">
        x
      </ThemeRoot>,
    );
    expect(screen.getByTestId('root')).not.toHaveAttribute('style');
  });

  it('follows the operating system when no theme is given', () => {
    render(<ThemeRoot data-testid="root">x</ThemeRoot>);
    expect(screen.getByTestId('root')).not.toHaveAttribute('data-theme');
    expect(screen.getByTestId('root')).not.toHaveAttribute('style');
  });
});

describe('[NFR-L02] UI strings', () => {
  it('explains how to provide strings when the provider is missing', () => {
    function Probe() {
      useUiStrings();
      return null;
    }
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/UiStringsProvider/);
    vi.restoreAllMocks();
  });
});
