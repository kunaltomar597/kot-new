import type { DeviceSession } from '@rp/mobile-core';
import type { FakeServer, RecordedCall } from '@rp/mobile-core/testing';
import { STAFF } from '@rp/mobile-core/testing';
import { IDS, sentOrder } from '@rp/ordering/testing';
import { fireEvent, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { Text } from 'react-native';
import { Button } from '@rp/ui-native';
import { OverrideCancelled, useOverride } from '../src/index.js';
import { ADDRESS, fakeServer, newSession, renderShell, translator } from './harness.js';

const VOID = `/api/v1/order-items/${IDS.orderItem}/void`;

function needsManager(call: RecordedCall) {
  if (call.headers['x-override-token'] === 'token-1') {
    return { status: 200, body: sentOrder('VOIDED') };
  }
  return {
    status: 403,
    body: {
      code: 'OVERRIDE_REQUIRED',
      message: 'A manager must approve this. Ask a manager to enter their PIN.',
      details: { capability: 'ITEM_VOID_AFTER_PREP' },
    },
  };
}

const granted = {
  status: 200,
  body: {
    overrideToken: 'token-1',
    expiresAt: '2026-09-26T09:00:00.000Z',
    approver: { id: STAFF.MANAGER.staffId, displayName: 'Meera', role: 'MANAGER' },
  },
};

/** Voids the fixture's line through the approval, and shows how it went. */
function Probe({ session }: { session: DeviceSession }) {
  const { withOverride, sheet } = useOverride();
  const [outcome, setOutcome] = useState('');
  const run = () => {
    withOverride(
      (overrideToken) =>
        session.api.voidOrderItem({
          params: { orderItemId: IDS.orderItem },
          body: { reason: 'Dropped on the floor' },
          ...(overrideToken !== undefined && { overrideToken }),
        }),
      { entityType: 'order_item', entityId: IDS.orderItem },
    ).then(
      (order) => {
        setOutcome(`done: ${order.items[0]?.state ?? ''}`);
      },
      (error: unknown) => {
        setOutcome(error instanceof OverrideCancelled ? 'cancelled' : 'failed');
      },
    );
  };
  return (
    <>
      <Button onPress={run}>Void</Button>
      <Text testID="outcome">{outcome}</Text>
      {sheet}
    </>
  );
}

async function signedIn(server: FakeServer) {
  const context = newSession(server);
  await context.session.start();
  await context.session.pair(ADDRESS, 'ABCD-EFGH');
  await context.session.signIn(STAFF.WAITER.staffId, '4444');
  await renderShell(context.session, <Probe session={context.session} />);
  return context;
}

async function pressDigits(pin: string) {
  for (const digit of pin) {
    await fireEvent.press(screen.getByRole('button', { name: digit }));
  }
}

describe("[AUTH-011] [WTR-009] a manager's approval on the phone", () => {
  it('asks a manager for their PIN when the server needs it, then sends the action again', async () => {
    const server = fakeServer()
      .on('POST', VOID, needsManager)
      .on(
        'POST',
        '/api/v1/auth/override',
        () => ({ status: 401, body: { code: 'PIN_INVALID', message: 'Wrong PIN. Try again.' } }),
        () => granted,
      );
    await signedIn(server);
    await fireEvent.press(screen.getByRole('button', { name: 'Void' }));

    expect(await screen.findByText(translator('override.title'))).toBeOnTheScreen();
    // Managers and the owner approve; the waiter asking and the cashier do not.
    await screen.findByRole('button', { name: 'Meera' });
    expect(screen.getByRole('button', { name: 'Kunal' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Ravi' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Asha' })).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Meera' }));
    await pressDigits('1111');
    expect(await screen.findByText('Wrong PIN. Try again.')).toBeOnTheScreen();
    await pressDigits('2222');

    expect(await screen.findByText('done: VOIDED')).toBeOnTheScreen();
    expect(screen.queryByText(translator('override.title'))).toBeNull();
    expect(server.callsTo('POST', '/api/v1/auth/override').map((call) => call.body)).toEqual([
      {
        approverStaffId: STAFF.MANAGER.staffId,
        pin: '1111',
        capability: 'ITEM_VOID_AFTER_PREP',
        entityType: 'order_item',
        entityId: IDS.orderItem,
      },
      {
        approverStaffId: STAFF.MANAGER.staffId,
        pin: '2222',
        capability: 'ITEM_VOID_AFTER_PREP',
        entityType: 'order_item',
        entityId: IDS.orderItem,
      },
    ]);
    const voids = server.callsTo('POST', VOID);
    expect(voids.map((call) => call.headers['x-override-token'])).toEqual([undefined, 'token-1']);
  });

  it('lets another manager approve instead, and takes no action when closed', async () => {
    const server = fakeServer().on('POST', VOID, needsManager);
    await signedIn(server);
    await fireEvent.press(screen.getByRole('button', { name: 'Void' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Meera' }));
    await fireEvent.press(
      screen.getByRole('button', { name: translator('override.otherManager') }),
    );
    expect(screen.getByRole('button', { name: 'Kunal' })).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: translator('ui.dialog.close') }));
    expect(await screen.findByText('cancelled')).toBeOnTheScreen();
    expect(server.callsTo('POST', '/api/v1/auth/override')).toHaveLength(0);
    expect(server.callsTo('POST', VOID)).toHaveLength(1);
  });

  it('needs no manager when the server allows the action, and passes other refusals on', async () => {
    const server = fakeServer().on(
      'POST',
      VOID,
      () => ({ status: 200, body: sentOrder('VOIDED') }),
      () => ({
        status: 409,
        body: { code: 'ITEM_NOT_STARTED', message: 'The kitchen has not started this item.' },
      }),
    );
    await signedIn(server);
    await fireEvent.press(screen.getByRole('button', { name: 'Void' }));
    expect(await screen.findByText('done: VOIDED')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Void' }));
    expect(await screen.findByText('failed')).toBeOnTheScreen();
    expect(screen.queryByText(translator('override.title'))).toBeNull();
  });

  it('says so when nobody on this device can approve', async () => {
    const server = fakeServer()
      .on('POST', VOID, needsManager)
      .on('GET', '/api/v1/auth/staff-tiles', () => ({
        status: 200,
        body: { staff: [STAFF.WAITER, STAFF.CASHIER] },
      }));
    await signedIn(server);
    await fireEvent.press(screen.getByRole('button', { name: 'Void' }));
    expect(await screen.findByText(translator('override.noManagers'))).toBeOnTheScreen();
  });
});
