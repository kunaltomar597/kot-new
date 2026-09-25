import { screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BUTTON_VARIANTS, Button, Icon, IconButton } from '../src/index.js';
import { expectNoAxeViolations, renderUi } from './render.js';

describe('[NFR-U01] Button', () => {
  it('is a real button of type "button" that reports clicks', async () => {
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    const { user } = renderUi(
      <Button onClick={onClick} ref={ref}>
        Send KOT
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Send KOT' });
    expect(button).toHaveAttribute('type', 'button');
    expect(ref.current).toBe(button);
    await user.click(button);
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it.each(BUTTON_VARIANTS)('renders the %s variant', (variant) => {
    renderUi(
      <Button variant={variant} size="lg" fullWidth startIcon={<Icon name="plus" />}>
        Add
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Add' });
    expect(button).toHaveAttribute('data-variant', variant);
    expect(button).toHaveAttribute('data-size', 'lg');
    expect(button).toHaveClass('rp-button', 'rp-button--full');
  });

  it('blocks repeat presses while loading', async () => {
    const onClick = vi.fn();
    const { user } = renderUi(
      <Button loading onClick={onClick} endIcon={<Icon name="send" />}>
        Submit order
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Submit order' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('[NFR-U01] IconButton', () => {
  it('uses the label as accessible name and tooltip', async () => {
    const onClick = vi.fn();
    const { user, container } = renderUi(
      <IconButton label="Close" icon={<Icon name="close" />} onClick={onClick} />,
    );
    const button = screen.getByRole('button', { name: 'Close' });
    expect(button).toHaveAttribute('title', 'Close');
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    await expectNoAxeViolations(container);
  });

  it('allows a different tooltip', () => {
    renderUi(<IconButton label="Refresh" title="Refresh orders" icon={<Icon name="sync" />} />);
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute(
      'title',
      'Refresh orders',
    );
  });
});
