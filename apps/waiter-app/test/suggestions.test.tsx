import type { RecommendationEventInput, SubmitOrderRequest } from '@rp/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { IDS, Restaurant, signedInApp } from './restaurant';

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));

const RULE = '0199a0e0-0000-7000-8000-000000009901';

describe('[WTR-011] [REC-008] upsell prompts on the waiter app', () => {
  it('suggests for the table’s order, adds with one tap and counts what happened', async () => {
    const restaurant = new Restaurant();
    restaurant.suggestions = [
      {
        itemId: IDS.dal,
        layer: 'RULE',
        reason: { kind: 'RULE', ruleId: RULE, label: null, becauseOf: 'Paneer Tikka' },
      },
    ];
    const { server, sockets } = await signedInApp(restaurant);
    await act(async () => {
      sockets.sync(0);
      await Promise.resolve();
    });
    await fireEvent.press(await screen.findByRole('button', { name: /^T2, / }));
    const row = within(await screen.findByTestId('suggestions-upsell'));
    expect(row.getByText('Goes well with Paneer Tikka')).toBeOnTheScreen();
    await fireEvent.press(row.getByTestId(`suggestion-${IDS.dal}`));
    await fireEvent.press(await screen.findByTestId('send-kot'));
    await waitFor(() => {
      expect(server.callsTo('POST', '/api/v1/orders')).toHaveLength(1);
    });
    const sent = server.callsTo('POST', '/api/v1/orders')[0]?.body as SubmitOrderRequest;
    expect(sent.lines[0]).toMatchObject({
      itemId: IDS.dal,
      recommendation: { layer: 'RULE', ruleId: RULE },
    });
    await waitFor(
      () => {
        expect(server.callsTo('POST', '/api/v1/recommendations/events').length).toBeGreaterThan(0);
      },
      { timeout: 6_000 },
    );
    const events = server
      .callsTo('POST', '/api/v1/recommendations/events')
      .flatMap((call) => (call.body as { events: RecommendationEventInput[] }).events)
      .map((event) => event.kind);
    expect(events).toEqual(expect.arrayContaining(['IMPRESSION', 'TAP', 'ADD_TO_CART']));
  });
});
