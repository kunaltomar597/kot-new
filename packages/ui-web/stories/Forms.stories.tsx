import type { Meta, StoryObj } from '@storybook/react-vite';
import { Select, TextField } from '../src/index.js';

const meta: Meta<typeof TextField> = {
  title: 'Input/Fields',
  component: TextField,
};
export default meta;
type Story = StoryObj<typeof TextField>;

export const Fields: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 20, maxWidth: 420 }}>
      <TextField label="Customer name" placeholder="Optional" />
      <TextField label="Phone" hint="10 digits, used for the bill SMS" inputMode="tel" />
      <TextField
        label="Void reason"
        required
        defaultValue="x"
        error="Enter a reason of at least 3 letters."
      />
      <TextField label="Weight" endAdornment="kg" inputMode="decimal" />
      <Select
        label="Move to table"
        placeholder="Choose a table"
        defaultValue=""
        required
        options={[
          { value: 't1', label: 'Table 1 (free)' },
          { value: 't2', label: 'Table 2 (free)' },
          { value: 't3', label: 'Table 3 (occupied)', disabled: true },
        ]}
      />
      <Select
        label="Station"
        error="Choose a station."
        options={[{ value: 'tandoor', label: 'Tandoor' }]}
      />
      <TextField label="Disabled" disabled defaultValue="Read only" />
    </div>
  ),
};
