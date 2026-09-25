import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PinPad } from '../src/index.js';
import { expectNoAxeViolations, renderUi } from './render.js';

function pad() {
  return screen.getByRole('group', { name: 'Enter your PIN' });
}

function filledDots(container: HTMLElement) {
  return container.querySelectorAll('.rp-pin-pad__dot[data-filled="true"]').length;
}

describe('[AUTH-004] PinPad', () => {
  it('submits a 4-digit PIN entered by tapping the keys (touch)', async () => {
    const onComplete = vi.fn();
    const { user } = renderUi(<PinPad label="Enter your PIN" onComplete={onComplete} />);
    for (const digit of ['4', '0', '2', '9']) {
      await user.pointer({ keys: '[TouchA]', target: screen.getByRole('button', { name: digit }) });
    }
    expect(onComplete).toHaveBeenCalledExactlyOnceWith('4029');
  });

  it('submits a PIN typed on a physical keyboard, with Backspace and Escape', async () => {
    const onComplete = vi.fn();
    const { user, container } = renderUi(
      <PinPad label="Enter your PIN" onComplete={onComplete} autoFocus />,
    );
    expect(pad()).toHaveFocus();
    await user.keyboard('12');
    expect(filledDots(container)).toBe(2);
    await user.keyboard('{Backspace}');
    expect(filledDots(container)).toBe(1);
    await user.keyboard('{Escape}');
    expect(filledDots(container)).toBe(0);
    await user.keyboard('5{Delete}');
    expect(filledDots(container)).toBe(0);
    await user.keyboard('9876');
    expect(onComplete).toHaveBeenCalledExactlyOnceWith('9876');
  });

  it('is operable with Tab and Enter/Space on the on-screen keys', async () => {
    const onComplete = vi.fn();
    const { user } = renderUi(<PinPad label="Enter your PIN" onComplete={onComplete} />);
    await user.tab();
    expect(pad()).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '1' })).toHaveFocus();
    // Enter on a focused key presses that key only; it does not submit the pad.
    await user.keyboard('{Enter}');
    await user.tab();
    await user.keyboard(' ');
    await user.keyboard('{Enter}{Enter}');
    expect(onComplete).toHaveBeenCalledExactlyOnceWith('1222');
  });

  it('ignores modifier shortcuts and unrelated keys', async () => {
    const onComplete = vi.fn();
    const { user, container } = renderUi(
      <PinPad label="Enter your PIN" onComplete={onComplete} autoFocus />,
    );
    await user.keyboard('{Control>}1{/Control}a');
    expect(filledDots(container)).toBe(0);
  });

  it('[AUTH-002] never renders or announces the digits', async () => {
    const { user, container } = renderUi(
      <PinPad label="Enter your PIN" onComplete={() => undefined} autoFocus />,
    );
    await user.keyboard('73');
    expect(screen.getByText('2 of 4 digits entered')).toHaveAttribute('aria-live', 'polite');
    const text = container.textContent.replace(/[0-9] of [0-9] digits entered/, '');
    // Key labels are 0-9 once each; the entered digits must not appear anywhere else.
    expect(text.match(/7/g)).toHaveLength(1);
    expect(text.match(/3/g)).toHaveLength(1);
    expect(container.innerHTML).not.toContain('73');
  });

  it('[AUTH-001] supports a 6-digit PIN when the owner requires it', async () => {
    const onComplete = vi.fn();
    const { user, container } = renderUi(
      <PinPad label="Enter your PIN" length={6} onComplete={onComplete} autoFocus />,
    );
    expect(container.querySelectorAll('.rp-pin-pad__dot')).toHaveLength(6);
    await user.keyboard('1234');
    expect(onComplete).not.toHaveBeenCalled();
    await user.keyboard('56');
    expect(onComplete).toHaveBeenCalledExactlyOnceWith('123456');
  });

  it('clears itself after submitting so a retry starts empty', async () => {
    const onComplete = vi.fn();
    const { user, container } = renderUi(
      <PinPad label="Enter your PIN" onComplete={onComplete} autoFocus />,
    );
    await user.keyboard('1111');
    expect(filledDots(container)).toBe(0);
    expect(screen.getByText('0 of 4 digits entered')).toBeInTheDocument();
  });

  it('with autoSubmit off, waits for the submit key or Enter', async () => {
    const onComplete = vi.fn();
    const { user } = renderUi(
      <PinPad label="Enter your PIN" onComplete={onComplete} autoSubmit={false} autoFocus />,
    );
    const submit = screen.getByRole('button', { name: /Enter$/ });
    expect(submit).toBeDisabled();
    await user.keyboard('123{Enter}');
    expect(onComplete).not.toHaveBeenCalled();
    await user.keyboard('45');
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(onComplete).toHaveBeenCalledExactlyOnceWith('1234');
    await user.click(screen.getByRole('button', { name: '9' }));
    pad().focus();
    await user.keyboard('999{Enter}');
    expect(onComplete).toHaveBeenLastCalledWith('9999');
  });

  it('shows the error as an alert linked to the pad', () => {
    renderUi(
      <PinPad label="Enter your PIN" onComplete={() => undefined} error="Wrong PIN. Try again." />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Wrong PIN. Try again.');
    expect(pad()).toHaveAccessibleDescription('Wrong PIN. Try again.');
  });

  it('blocks input while busy or disabled', async () => {
    const onComplete = vi.fn();
    const { user, rerender, container } = renderUi(
      <PinPad label="Enter your PIN" onComplete={onComplete} busy autoFocus />,
    );
    expect(pad()).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: '1' })).toBeDisabled();
    await user.keyboard('1234');
    expect(filledDots(container)).toBe(0);
    rerender(<PinPad label="Enter your PIN" onComplete={onComplete} disabled />);
    fireEvent.keyDown(pad(), { key: '1' });
    expect(filledDots(container)).toBe(0);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('deletes digits with the on-screen backspace and clear keys', async () => {
    const { user, container } = renderUi(
      <PinPad label="Enter your PIN" onComplete={() => undefined} />,
    );
    const backspace = screen.getByRole('button', { name: 'Delete last digit' });
    expect(backspace).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '5' }));
    await user.click(screen.getByRole('button', { name: '6' }));
    await user.click(backspace);
    expect(filledDots(container)).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(filledDots(container)).toBe(0);
  });

  it('uses the generic accessible name when the screen gives none', () => {
    renderUi(<PinPad onComplete={() => undefined} />);
    expect(screen.getByRole('group', { name: 'PIN' })).toBeInTheDocument();
  });

  it('rejects PIN lengths outside 4 to 8', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const length of [3, 9, 4.5]) {
      expect(() => renderUi(<PinPad onComplete={() => undefined} length={length} />)).toThrow(
        RangeError,
      );
    }
    vi.restoreAllMocks();
  });

  it('[KDS-011] renders in the KDS theme with the same behaviour', async () => {
    const onComplete = vi.fn();
    const { user, container } = renderUi(
      <PinPad label="Enter your PIN" onComplete={onComplete} autoFocus />,
      { theme: 'kds' },
    );
    expect(container.querySelector('[data-theme="kds"]')).toContainElement(pad());
    await act(async () => {
      await user.keyboard('0000');
    });
    expect(onComplete).toHaveBeenCalledWith('0000');
  });

  it('has no axe violations, with and without an error', async () => {
    const { container, rerender } = renderUi(
      <PinPad label="Enter your PIN" onComplete={() => undefined} autoSubmit={false} />,
    );
    await expectNoAxeViolations(container);
    rerender(<PinPad label="Enter your PIN" onComplete={() => undefined} error="Wrong PIN." />);
    await expectNoAxeViolations(container);
  });
});
