import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Money, NumberPad, parseRupeesOrZero, PinPad, TextField } from './support.js';

const meta: Meta<typeof PinPad> = {
  title: 'Input/Keypads',
  component: PinPad,
};
export default meta;
type Story = StoryObj<typeof PinPad>;

function LoginPinPad({ length, autoSubmit }: { length: number; autoSubmit: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ maxWidth: 360 }}>
      <PinPad
        label="Enter your PIN"
        length={length}
        autoSubmit={autoSubmit}
        autoFocus
        busy={busy}
        error={error}
        onComplete={(pin) => {
          setBusy(true);
          setTimeout(() => {
            setBusy(false);
            // Demo only: 1234 is "correct".
            setError(pin.startsWith('1234') ? null : 'Wrong PIN. Try again.');
          }, 400);
        }}
      />
    </div>
  );
}

export const PinPadFourDigits: Story = {
  name: 'PIN pad (4 digits)',
  render: () => <LoginPinPad length={4} autoSubmit />,
};

export const PinPadSixDigitsManualSubmit: Story = {
  name: 'PIN pad (6 digits, submit key)',
  render: () => <LoginPinPad length={6} autoSubmit={false} />,
};

export const CashNumberPad: Story = {
  name: 'Number pad (cash received)',
  render: function Render() {
    const [value, setValue] = useState('');
    return (
      <div style={{ maxWidth: 360, display: 'grid', gap: 16 }}>
        <TextField label="Cash received (₹)" value={value} readOnly inputMode="none" />
        <p>
          Change due: <Money paise={Math.max(0, parseRupeesOrZero(value) - 76_000)} strong />
        </p>
        <NumberPad
          label="Cash received"
          value={value}
          onChange={setValue}
          allowDecimal
          maxLength={9}
          onSubmit={() => undefined}
          submitLabel="Done"
        />
      </div>
    );
  },
};
