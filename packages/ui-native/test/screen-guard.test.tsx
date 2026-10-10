import { screen } from '@testing-library/react-native';
import { PinPad, setScreenGuard } from '../src/index.js';
import { renderUi } from './render.js';

describe('[SEC-010] [MOBILE-I4] a PIN pad blocks screen capture', () => {
  afterEach(() => {
    setScreenGuard(null);
  });

  it('secures the screen while a PIN pad shows, and only then', async () => {
    const calls: boolean[] = [];
    setScreenGuard({
      secure: (on) => {
        calls.push(on);
      },
    });
    const first = await renderUi(<PinPad onComplete={() => undefined} />);
    const second = await renderUi(<PinPad onComplete={() => undefined} />);
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
    expect(calls).toEqual([true]);
    await second.unmount();
    expect(calls).toEqual([true]);
    await first.unmount();
    expect(calls).toEqual([true, false]);
  });

  it('still works on a device that cannot block capture', async () => {
    setScreenGuard({ secure: () => Promise.reject(new Error('no window')) });
    const view = await renderUi(<PinPad onComplete={() => undefined} />);
    await view.unmount();
  });
});
