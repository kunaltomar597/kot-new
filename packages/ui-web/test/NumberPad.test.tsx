import { screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { applyNumberPadKey, NumberPad, type NumberPadOptions } from '../src/index.js';
import { expectNoAxeViolations, renderUi } from './render.js';

function type(keys: string[], options?: NumberPadOptions) {
  return keys.reduce((value, key) => applyNumberPadKey(value, key, options), '');
}

describe('[NFR-U03] applyNumberPadKey', () => {
  it('appends digits without leading zeros', () => {
    expect(type(['0', '0', '7'])).toBe('7');
    expect(type(['1', '0', '0'])).toBe('100');
    expect(type(['0'])).toBe('0');
  });

  it('handles backspace, clear and unknown keys', () => {
    expect(applyNumberPadKey('123', 'backspace')).toBe('12');
    expect(applyNumberPadKey('', 'backspace')).toBe('');
    expect(applyNumberPadKey('123', 'clear')).toBe('');
    expect(applyNumberPadKey('12', 'x')).toBe('12');
  });

  it('allows one decimal point with at most two decimals for rupee amounts', () => {
    const rupees = { allowDecimal: true };
    expect(type(['.', '5'], rupees)).toBe('0.5');
    expect(type(['1', '2', '.', '5', '0', '9', '.'], rupees)).toBe('12.50');
    expect(type(['1', '.'], { allowDecimal: true, maxDecimals: 0 })).toBe('1');
    expect(type(['1', '.', '5'])).toBe('15');
  });

  it('respects the maximum length', () => {
    expect(type(['9', '9', '9', '9'], { maxLength: 3 })).toBe('999');
    expect(type(['9', '9', '9', '.'], { maxLength: 3, allowDecimal: true })).toBe('999');
  });
});

function Harness(props: { onSubmit?: () => void; allowDecimal?: boolean; disabled?: boolean }) {
  const [value, setValue] = useState('');
  return (
    <>
      <output data-testid="value">{value}</output>
      <NumberPad
        label="Cash received"
        value={value}
        onChange={setValue}
        submitLabel="Done"
        {...props}
      />
    </>
  );
}

describe('[NFR-U03] NumberPad', () => {
  it('builds a value from taps and keyboard typing', async () => {
    const onSubmit = vi.fn();
    const { user } = renderUi(<Harness onSubmit={onSubmit} allowDecimal />);
    await user.pointer({ keys: '[TouchA]', target: screen.getByRole('button', { name: '5' }) });
    await user.click(screen.getByRole('button', { name: 'Decimal point' }));
    screen.getByRole('group', { name: 'Cash received' }).focus();
    await user.keyboard('2,9{Backspace}');
    expect(screen.getByTestId('value')).toHaveTextContent('5.2');
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByTestId('value')).toBeEmptyDOMElement();
  });

  it('shows Clear in the grid when decimals are off, and Escape clears', async () => {
    const { user } = renderUi(<Harness />);
    expect(screen.queryByRole('button', { name: 'Decimal point' })).not.toBeInTheDocument();
    screen.getByRole('group', { name: 'Cash received' }).focus();
    await user.keyboard('42');
    expect(screen.getByTestId('value')).toHaveTextContent('42');
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('value')).toBeEmptyDOMElement();
    await user.keyboard('{Enter}a');
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
  });

  it('ignores input when disabled', async () => {
    const { user } = renderUi(<Harness disabled />);
    screen.getByRole('group', { name: 'Cash received' }).focus();
    await user.keyboard('7');
    expect(screen.getByTestId('value')).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: '7' })).toBeDisabled();
  });

  it('has no axe violations', async () => {
    const { container } = renderUi(<Harness onSubmit={() => undefined} allowDecimal />);
    await expectNoAxeViolations(container);
  });
});
