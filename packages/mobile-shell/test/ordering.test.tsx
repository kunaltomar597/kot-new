import type { RecommendationsResponse, RecommendationView } from '@rp/contracts';
import type { DeviceSession, SuggestionTracker } from '@rp/mobile-core';
import { IDS, MENU } from '@rp/ordering/testing';
import { act, fireEvent, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Text } from 'react-native';
import { ItemSheet, ShellProvider, sourceOf, SuggestionRow, useSuggestions } from '../src/index.js';
import { ADDRESS, newSession, renderShell, translator } from './harness.js';

const RULE = '0199a0e0-0000-7000-8000-000000009901';

async function pairedSession() {
  const context = newSession();
  await context.session.start();
  await context.session.pair(ADDRESS, 'ABCD-EFGH');
  return context;
}

/** What a rerender gets: the whole tree, with its provider. */
function inShell(session: DeviceSession, ui: ReactElement) {
  return (
    <ShellProvider session={session} translator={translator}>
      {ui}
    </ShellProvider>
  );
}

function itemOf(id: string) {
  const item = MENU.items.find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error(id);
  return item;
}

describe('[WTR-003] [MENU-012] the item sheet on a phone or tablet', () => {
  it('asks for a size, then adds the dish with its add-ons, quantity and note', async () => {
    const { session } = await pairedSession();
    const onAdd = jest.fn();
    await renderShell(
      session,
      <ItemSheet menu={MENU} item={itemOf(IDS.tikka)} onClose={jest.fn()} onAdd={onAdd} />,
    );
    expect(screen.getByRole('header', { name: 'Paneer Tikka' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('item-add'));
    expect(screen.getByText('Choose a size.')).toBeOnTheScreen();
    expect(onAdd).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('radio', { name: 'Full, ₹280.00' }));
    await fireEvent.press(screen.getByRole('checkbox', { name: 'Cheese, +₹40.00' }));
    await fireEvent.press(screen.getByRole('button', { name: 'One more' }));
    await fireEvent.changeText(
      screen.getByLabelText(translator('pos.item.instructions')),
      '  Less spicy ',
    );
    expect(screen.getByText('₹640.00')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('item-add'));
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: IDS.tikka,
        name: 'Paneer Tikka',
        quantity: 2,
        instructions: 'Less spicy',
        unitPrice: 32_000,
      }),
    );
  });

  it('adds a combo only with its choices, worded for guests, with what goes with it', async () => {
    const { session } = await pairedSession();
    const onAdd = jest.fn();
    await renderShell(
      session,
      <ItemSheet
        menu={MENU}
        item={itemOf(IDS.thali)}
        onClose={jest.fn()}
        onAdd={onAdd}
        addLabel="Add to your order"
        extra={<Text>Goes well with Lassi</Text>}
      />,
    );
    expect(screen.getByText('Goes well with Lassi')).toBeOnTheScreen();
    expect(screen.getByTestId('item-add')).toHaveTextContent('Add to your order');
    await fireEvent.press(screen.getByTestId('item-add'));
    expect(screen.getByText(translator('pos.item.comboMissing'))).toBeOnTheScreen();
    expect(onAdd).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('radio', { name: /^Gulab Jamun/ }));
    await fireEvent.press(screen.getByTestId('item-add'));
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: IDS.thali, comboChoices: [IDS.jamun], quantity: 1 }),
    );
  });
});

describe('[TAB-011] [WTR-011] [REC-008] a row of suggestions', () => {
  const ruleSuggestion: RecommendationView = {
    itemId: IDS.dal,
    layer: 'RULE',
    reason: { kind: 'RULE', ruleId: RULE, label: null, becauseOf: 'Paneer Tikka' },
  };
  const bestSeller: RecommendationView = {
    itemId: IDS.tikka,
    layer: 'BEST_SELLER',
    reason: { kind: 'BEST_SELLER', daypart: null },
  };

  function fakeTracker() {
    const record = jest.fn();
    return { record, tracker: { record } as unknown as SuggestionTracker };
  }

  it('shows each dish with why, counts it shown once, and a press as a tap', async () => {
    const { session } = await pairedSession();
    const { record, tracker } = fakeTracker();
    const onChoose = jest.fn();
    const unknown: RecommendationView = { ...bestSeller, itemId: IDS.session };
    const view = await renderShell(
      session,
      <SuggestionRow
        title="Goes well"
        suggestions={[ruleSuggestion, bestSeller, unknown]}
        menu={MENU}
        tracker={tracker}
        onChoose={onChoose}
        testID="row"
      />,
    );
    expect(screen.getByRole('header', { name: 'Goes well' })).toBeOnTheScreen();
    expect(screen.getByText('Goes well with Paneer Tikka')).toBeOnTheScreen();
    // A suggestion for a dish the menu no longer lists is left out.
    expect(screen.queryByTestId(`suggestion-${IDS.session}`)).toBeNull();
    expect(record.mock.calls.map(([event]: [{ kind: string; itemId: string }]) => event)).toEqual([
      expect.objectContaining({ kind: 'IMPRESSION', itemId: IDS.dal, layer: 'RULE', ruleId: RULE }),
      expect.objectContaining({ kind: 'IMPRESSION', itemId: IDS.tikka, ruleId: null }),
    ]);

    await view.rerender(
      inShell(
        session,
        <SuggestionRow
          title="Goes well"
          suggestions={[bestSeller, ruleSuggestion]}
          menu={MENU}
          tracker={tracker}
          onChoose={onChoose}
        />,
      ),
    );
    expect(record).toHaveBeenCalledTimes(2);

    await fireEvent.press(screen.getByTestId(`suggestion-${IDS.dal}`));
    expect(record).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'TAP', itemId: IDS.dal, ruleId: RULE }),
    );
    expect(onChoose).toHaveBeenCalledWith(itemOf(IDS.dal), { layer: 'RULE', ruleId: RULE });
  });

  it('shows nothing without suggestions', async () => {
    const { session } = await pairedSession();
    const { tracker } = fakeTracker();
    await renderShell(
      session,
      <SuggestionRow
        title="Goes well"
        suggestions={[]}
        menu={MENU}
        tracker={tracker}
        onChoose={jest.fn()}
        testID="row"
      />,
    );
    expect(screen.queryByTestId('row')).toBeNull();
    expect(sourceOf(bestSeller)).toEqual({ layer: 'BEST_SELLER', ruleId: null });
  });

  it('reads suggestions once online and again for a new key, and none when turned off', async () => {
    const { session, sockets } = await pairedSession();
    const response: RecommendationsResponse = {
      recommendations: [ruleSuggestion],
      daypart: null,
      menuVersion: 1,
    };
    const load = jest.fn(() => Promise.resolve(response));
    function Probe({ cart, enabled }: { cart: string; enabled: boolean }) {
      const suggestions = useSuggestions(load, cart, enabled);
      return <Text testID="count">{String(suggestions.length)}</Text>;
    }
    const view = await renderShell(session, <Probe cart="a" enabled />);
    expect(load).not.toHaveBeenCalled();
    await act(async () => {
      sockets.sync(0);
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('count')).toHaveTextContent('1');

    await view.rerender(inShell(session, <Probe cart="b" enabled />));
    await act(async () => {
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalledTimes(2);

    await view.rerender(inShell(session, <Probe cart="b" enabled={false} />));
    expect(screen.getByTestId('count')).toHaveTextContent('0');
  });
});
