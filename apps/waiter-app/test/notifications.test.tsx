import type { NotificationPermission } from '@rp/mobile-native';
import { alertView, HOLDER } from '@rp/mobile-core/testing';
import { act, fireEvent, screen } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { alertNotificationText } from '../src/notifications';
import { signedInApp, translator } from './restaurant';

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));

/** Android's answer to the notification question, and the settings screen, as a person uses them. */
function permission(granted: boolean) {
  const asked = { requests: 0, settingsOpened: 0, enabled: granted };
  const fake: NotificationPermission = {
    enabled: () => Promise.resolve(asked.enabled),
    request: () => {
      asked.requests += 1;
      return Promise.resolve(asked.enabled);
    },
    openSettings: () => {
      asked.settingsOpened += 1;
      return Promise.resolve();
    },
  };
  return { fake, asked };
}

/** The app coming back to the screen, as after the settings. */
async function comeBack() {
  // React Native's Jest preset mocks AppState, so this returns the mock with every listener added.
  const listeners = jest
    .spyOn(AppState, 'addEventListener')
    .mock.calls.filter(([type]) => type === 'change')
    .map(([, listener]) => listener);
  await act(async () => {
    for (const listener of listeners) listener('active');
    await Promise.resolve();
  });
}

describe('[WTR-005] the waiter phone’s notifications', () => {
  it('words an alert like the banner, and the service’s notification with the holder', () => {
    const text = alertNotificationText(translator);
    expect(text.alert(alertView())).toEqual({
      title: 'Table 5 · Food ready',
      text: 'Paneer Tikka',
    });
    expect(
      text.alert(
        alertView({
          type: 'BILL_REQUEST',
          payload: { requestedFrom: 'TABLE_TABLET' },
          tableLabel: '7',
        }),
      ),
    ).toEqual({ title: 'Table 7 · Bill requested', text: 'Asked on the table tablet' });
    expect(text.listening(HOLDER)).toEqual({
      title: `Alerts for ${HOLDER.displayName}`,
      text: `This phone rings for ${HOLDER.displayName}’s alerts, also when it is locked.`,
    });
    expect(text.acknowledge).toBe('Acknowledge');
    expect(text.channels).toEqual({ alerts: 'Alerts', listening: 'Staying connected for alerts' });
  });

  it('asks for notifications as the waiter signs in, and says so while they are off', async () => {
    const { fake, asked } = permission(false);
    await signedInApp(undefined, undefined, { notifications: fake });
    expect(await screen.findByTestId('notifications-off')).toBeOnTheScreen();
    expect(
      screen.getByText('Notifications are off, so alerts ring only while this app is open.'),
    ).toBeOnTheScreen();
    expect(asked.requests).toBe(1);

    await fireEvent.press(screen.getByRole('button', { name: 'Turn on' }));
    expect(asked.settingsOpened).toBe(1);

    // Turned on in the settings: gone when the app is back on the screen.
    asked.enabled = true;
    await comeBack();
    expect(screen.queryByTestId('notifications-off')).toBeNull();
    expect(asked.requests).toBe(1);
  });

  it('asks nothing before anyone signs in, and shows nothing when they are on', async () => {
    const { fake, asked } = permission(true);
    const { session } = await signedInApp(undefined, undefined, {
      notifications: fake,
      signIn: false,
    });
    expect(await screen.findByRole('button', { name: 'Ravi, Waiter' })).toBeOnTheScreen();
    expect(asked.requests).toBe(0);

    await act(async () => {
      await session.signIn(HOLDER.staffId, '4444');
    });
    expect(await screen.findByText('Signed in as Ravi')).toBeOnTheScreen();
    expect(asked.requests).toBe(1);
    expect(screen.queryByTestId('notifications-off')).toBeNull();
  });

  it('shows no hint on a phone that cannot say', async () => {
    // Rendered without the Android notifier, as in the other tests.
    await signedInApp();
    expect(await screen.findByText('Signed in as Ravi')).toBeOnTheScreen();
    expect(screen.queryByTestId('notifications-off')).toBeNull();
  });
});
