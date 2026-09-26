import { ORDER_ITEM_STATES, type OrderItemState } from '@rp/domain';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  Badge,
  Button,
  Card,
  ConnectionBanner,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  Money,
  StatusChip,
  TableTile,
  Table,
  Tabs,
} from '../src/index.js';

const meta: Meta = { title: 'Display/Gallery' };
export default meta;
type Story = StoryObj;

const STATE_LABELS: Record<OrderItemState, string> = {
  PENDING_APPROVAL: 'Awaiting approval',
  SENT: 'Sent',
  PREPARING: 'Preparing',
  READY: 'Ready',
  PICKED_UP: 'Picked up',
  SERVED: 'Served',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  VOIDED: 'Voided',
};

export const StatusChips: Story = {
  render: () => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {ORDER_ITEM_STATES.map((state) => (
        <StatusChip key={state} state={state} label={STATE_LABELS[state]} />
      ))}
      {ORDER_ITEM_STATES.map((state) => (
        <StatusChip key={`lg-${state}`} state={state} label={STATE_LABELS[state]} size="lg" />
      ))}
    </div>
  ),
};

export const TableTiles: Story = {
  render: () => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      <TableTile label="1" state="FREE" stateLabel="Free" onSelect={() => undefined} />
      <TableTile
        label="2"
        state="OCCUPIED"
        stateLabel="Occupied"
        details={['4 guests', '25 min', 'Ravi']}
        amountSoFar={123_450}
        onSelect={() => undefined}
      />
      <TableTile
        label="3"
        state="BILL_REQUESTED"
        stateLabel="Bill asked"
        details={['2 guests', '1 h 05 min', 'Priya']}
        amountSoFar={86_000}
        alert="1 to approve"
        onSelect={() => undefined}
      />
      <TableTile
        label="4"
        state="BILL_PRINTED"
        stateLabel="Bill printed"
        details={['6 guests', '1 h 40 min', 'Ravi']}
        amountSoFar={412_000}
        selected
        onSelect={() => undefined}
      />
    </div>
  ),
};

export const Badges: Story = {
  render: () => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {(['neutral', 'info', 'success', 'warning', 'danger'] as const).map((tone) => (
        <Badge key={tone} tone={tone}>
          {tone}
        </Badge>
      ))}
      <Badge tone="danger" variant="solid" icon={<Icon name="warning" size={14} />}>
        3 late
      </Badge>
    </div>
  ),
};

const rows = [
  { id: '1', item: 'Paneer tikka', qty: 2, paise: 58_000, state: 'READY' as const },
  { id: '2', item: 'Masala dosa', qty: 1, paise: 18_000, state: 'PREPARING' as const },
  { id: '3', item: 'Sweet lime soda', qty: 3, paise: 27_000, state: 'SERVED' as const },
];

export const TableWithMoney: Story = {
  render: () => (
    <Card title="Table 4 · 5 covers" actions={<Button variant="ghost">Print bill</Button>}>
      <Table
        caption="Items on the bill"
        hideCaption
        rows={rows}
        rowKey={(row) => row.id}
        columns={[
          { key: 'item', header: 'Item', cell: (row) => row.item },
          { key: 'qty', header: 'Qty', align: 'center', cell: (row) => row.qty },
          {
            key: 'state',
            header: 'Status',
            cell: (row) => <StatusChip state={row.state} label={STATE_LABELS[row.state]} />,
          },
          {
            key: 'amount',
            header: 'Amount',
            align: 'end',
            cell: (row) => <Money paise={row.paise} />,
          },
        ]}
        footer={
          <tr>
            <th scope="row" colSpan={3}>
              Total
            </th>
            <td data-align="end">
              <Money paise={103_000} strong />
            </td>
          </tr>
        }
      />
    </Card>
  ),
};

export const MoneyAmounts: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
      <Money paise={12_345_678} size="xl" strong />
      <Money paise={99_900} size="lg" />
      <Money paise={-5_050} signTone />
      <Money paise={1} size="sm" symbol={false} />
    </div>
  ),
};

export const TabsExample: Story = {
  name: 'Tabs',
  render: () => (
    <Tabs
      label="Order sources"
      items={[
        {
          id: 'pending',
          label: 'Pending',
          badge: <Badge tone="warning">2</Badge>,
          content: <p>Two orders need approval.</p>,
        },
        { id: 'kitchen', label: 'In kitchen', content: <p>Seven items preparing.</p> },
        { id: 'delivery', label: 'Delivery', content: null, disabled: true },
        { id: 'done', label: 'Done', content: <p>All served.</p> },
      ]}
    />
  ),
};

export const States: Story = {
  render: () => (
    <div
      style={{
        display: 'grid',
        gap: 16,
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
      }}
    >
      <Card>
        <EmptyState
          title="No orders yet"
          description="New orders from waiters, tablets and QR appear here."
          action={<Button>New order</Button>}
        />
      </Card>
      <Card>
        <LoadingState title="Loading tables…" />
      </Card>
      <Card>
        <ErrorState
          title="Could not load the menu"
          description="Check that the restaurant server is on, then try again."
          onRetry={() => undefined}
          retryLabel="Try again"
        />
      </Card>
    </div>
  ),
};

export const ConnectionBanners: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12 }}>
      <ConnectionBanner status="reconnecting" message="Reconnecting to the restaurant server…" />
      <ConnectionBanner
        status="offline"
        message="Can't reach the restaurant server. New orders will not reach the kitchen."
        action={<Button variant="secondary">Retry now</Button>}
      />
    </div>
  ),
};
