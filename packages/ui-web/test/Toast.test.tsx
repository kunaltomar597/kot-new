import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EN_STRINGS } from '../fixtures/en-strings.js';
import { type ToastApi, ToastProvider, UiStringsProvider, useToast } from '../src/index.js';
import { expectNoAxeViolations } from './render.js';

let api: ToastApi;
function Capture() {
  const toast = useToast();
  useEffect(() => {
    api = toast;
  }, [toast]);
  return null;
}

function setup(props: { duration?: number; max?: number } = {}) {
  return render(
    <UiStringsProvider strings={EN_STRINGS}>
      <ToastProvider {...props}>
        <Capture />
      </ToastProvider>
    </UiStringsProvider>,
  );
}

describe('[NFR-U04] Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows status toasts in a labelled region and hides them after the duration', () => {
    setup({ duration: 3000 });
    const region = screen.getByRole('region', { name: 'Notifications' });
    act(() => {
      api.show({ title: 'Order sent', description: 'KOT 42 printed', tone: 'success' });
    });
    expect(region).toContainElement(screen.getByRole('status'));
    expect(screen.getByRole('status')).toHaveTextContent('Order sentKOT 42 printed');
    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(screen.queryByRole('status')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps error toasts as alerts until dismissed', () => {
    setup();
    act(() => {
      api.show({ title: 'Printer offline', tone: 'danger' });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Printer offline');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('pauses the timer while hovered or focused (WCAG 2.2.1)', () => {
    setup({ duration: 1000 });
    act(() => {
      api.show({ title: 'Saved' });
    });
    const toast = screen.getByRole('status');
    act(() => {
      vi.advanceTimersByTime(600);
    });
    fireEvent.pointerEnter(toast);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(toast).toBeInTheDocument();
    fireEvent.pointerLeave(toast);
    fireEvent.focus(screen.getByRole('button', { name: 'Dismiss notification' }));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(toast).toBeInTheDocument();
    fireEvent.blur(screen.getByRole('button', { name: 'Dismiss notification' }));
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(toast).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(toast).not.toBeInTheDocument();
  });

  it('runs an action and dismisses, and supports sticky and explicit dismissal', () => {
    setup();
    const onAction = vi.fn();
    let sticky = '';
    act(() => {
      api.show({ title: 'Item removed', action: { label: 'Undo', onAction } });
      sticky = api.show({ title: 'Syncing', tone: 'neutral', duration: null });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.queryByText('Item removed')).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText('Syncing')).toBeInTheDocument();
    act(() => {
      api.dismiss(sticky);
    });
    expect(screen.queryByText('Syncing')).not.toBeInTheDocument();
  });

  it('keeps only the newest toasts', () => {
    setup({ max: 2 });
    act(() => {
      for (const title of ['One', 'Two', 'Three']) api.show({ title, tone: 'warning' });
    });
    expect(screen.queryByText('One')).not.toBeInTheDocument();
    expect(screen.getAllByRole('status')).toHaveLength(2);
  });

  it('has no axe violations', async () => {
    vi.useRealTimers();
    const { container } = setup();
    act(() => {
      api.show({ title: 'Saved', tone: 'info' });
      api.show({ title: 'Failed', tone: 'danger' });
    });
    await expectNoAxeViolations(container);
  });

  it('explains a missing provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Capture />)).toThrow(/ToastProvider/);
    vi.restoreAllMocks();
  });
});
