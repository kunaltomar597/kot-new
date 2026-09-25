import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Select, TextField } from '../src/index.js';
import { expectNoAxeViolations, renderUi } from './render.js';

describe('[NFR-U05] TextField', () => {
  it('labels the input and links hint and error', async () => {
    const { user, container } = renderUi(
      <TextField
        label="Reason"
        hint="Shown on the void report"
        error="Enter a reason of at least 3 letters."
        required
        endAdornment="kg"
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Reason' });
    expect(input).toBeRequired();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(
      'Shown on the void report Enter a reason of at least 3 letters.',
    );
    await user.type(input, 'Spilled');
    expect(input).toHaveValue('Spilled');
    expect(screen.getByText('kg')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('has no description or invalid state when there is no hint or error', () => {
    renderUi(<TextField label="Name" id="name" />);
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input).toHaveAttribute('id', 'name');
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(input).not.toHaveAttribute('aria-invalid');
  });
});

describe('[NFR-U05] Select', () => {
  const options = [
    { value: 't1', label: 'Table 1' },
    { value: 't2', label: 'Table 2' },
    { value: 't3', label: 'Table 3', disabled: true },
  ];

  it('offers the options with a placeholder and reports the choice', async () => {
    const { user, container } = renderUi(
      <Select
        label="Table"
        options={options}
        placeholder="Choose a table"
        defaultValue=""
        hint="Only free tables"
        required
      />,
    );
    const select = screen.getByRole('combobox', { name: 'Table' });
    expect(select).toHaveAccessibleDescription('Only free tables');
    expect(screen.getByRole('option', { name: 'Choose a table' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Table 3' })).toBeDisabled();
    await user.selectOptions(select, 't2');
    expect(select).toHaveValue('t2');
    await expectNoAxeViolations(container);
  });

  it('shows an error', () => {
    renderUi(<Select label="Station" options={options} error="Choose a station." />);
    const select = screen.getByRole('combobox', { name: 'Station' });
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select).toHaveAccessibleDescription('Choose a station.');
  });
});
