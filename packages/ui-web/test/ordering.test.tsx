import { type ItemSelection, type ModifierGroupDef, validateSelection } from '@rp/domain';
import { screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  ChoiceGroup,
  ComboChoices,
  ItemOptions,
  MenuItemCard,
  QuantityStepper,
} from '../src/index.js';
import { expectNoAxeViolations, renderUi } from './render.js';

const HALF = { id: 'half', name: 'Half', price: 18_000 };
const FULL = { id: 'full', name: 'Full', price: 28_000 };
const SPICE: ModifierGroupDef = {
  id: 'spice',
  name: 'Spice level',
  minSelections: 0,
  maxSelections: 1,
  options: [
    { id: 'mild', name: 'Mild', priceDelta: 0 },
    { id: 'hot', name: 'Hot', priceDelta: 0 },
  ],
};
const EXTRAS: ModifierGroupDef = {
  id: 'extras',
  name: 'Extras',
  minSelections: 1,
  maxSelections: 2,
  options: [
    { id: 'cheese', name: 'Cheese', priceDelta: 4_000 },
    { id: 'butter', name: 'Butter', priceDelta: 2_000 },
    { id: 'plain', name: 'No onion', priceDelta: -500 },
  ],
};
const LABELS = {
  issue: (issue: { code: string }) =>
    issue.code === 'VARIANT_REQUIRED' ? 'Pick a size' : 'Fix this',
  variant: 'Size',
  none: 'None',
  rule: (group: ModifierGroupDef) =>
    group.minSelections === 0
      ? `Optional, up to ${String(group.maxSelections)}`
      : `Choose ${String(group.minSelections)} to ${String(group.maxSelections)}`,
};

describe('[MENU-012] MenuItemCard', () => {
  it('shows name, price, food mark and note, and speaks them', async () => {
    const onSelect = vi.fn();
    const { user, container } = renderUi(
      <MenuItemCard
        name="Paneer Tikka"
        price={28_000}
        foodType="VEG"
        foodTypeLabel="Veg"
        note="Choose options"
        onSelect={onSelect}
      />,
    );
    const card = screen.getByRole('button', {
      name: 'Paneer Tikka, ₹280.00, Veg, Choose options',
    });
    expect(card.querySelector('.rp-food-mark')).toHaveAttribute('data-food', 'VEG');
    await user.click(card);
    expect(onSelect).toHaveBeenCalledOnce();
    await expectNoAxeViolations(container);
  });

  it('is disabled with the reason when it cannot be ordered', () => {
    renderUi(
      <MenuItemCard
        name="Gulab Jamun"
        price={9_000}
        foodType="VEG"
        foodTypeLabel="Veg"
        note="3 left"
        unavailable="Sold out"
      />,
    );
    const card = screen.getByRole('button', { name: 'Gulab Jamun, ₹90.00, Veg, Sold out' });
    expect(card).toBeDisabled();
    expect(card).not.toHaveTextContent('3 left');
  });
});

describe('[MENU-003] [MENU-004] ItemOptions', () => {
  function Harness({ onSelection }: { onSelection: (selection: ItemSelection) => void }) {
    const [selection, setSelection] = useState<ItemSelection>({});
    const item = {
      id: 'tikka',
      basePrice: 0,
      variants: [HALF, FULL],
      modifierGroups: [SPICE, EXTRAS],
    };
    return (
      <ItemOptions
        variants={item.variants}
        modifierGroups={item.modifierGroups}
        selection={selection}
        onChange={(next) => {
          setSelection(next);
          onSelection(next);
        }}
        labels={LABELS}
        issues={validateSelection(item, selection)}
      />
    );
  }

  it('offers variants with prices, optional and required groups, and enforces the maximum', async () => {
    const onSelection = vi.fn();
    const { user, container } = renderUi(<Harness onSelection={onSelection} />);
    const size = screen.getByRole('group', { name: 'Size' });
    expect(within(size).getByText('Pick a size')).toBeInTheDocument();
    await user.click(within(size).getByRole('radio', { name: /Full/ }));
    expect(within(size).getByText('₹280.00')).toBeInTheDocument();

    const spice = screen.getByRole('group', { name: 'Spice level' });
    expect(within(spice).getByRole('radio', { name: 'None' })).toBeChecked();
    await user.click(within(spice).getByRole('radio', { name: 'Hot' }));
    await user.click(within(spice).getByRole('radio', { name: 'None' }));

    const extras = screen.getByRole('group', { name: 'Extras' });
    expect(within(extras).getByText('Choose 1 to 2')).toBeInTheDocument();
    expect(within(extras).getByText('+₹40.00')).toBeInTheDocument();
    expect(within(extras).getByText('-₹5.00')).toBeInTheDocument();
    await user.click(within(extras).getByRole('checkbox', { name: /Cheese/ }));
    await user.click(within(extras).getByRole('checkbox', { name: /Butter/ }));
    expect(within(extras).getByRole('checkbox', { name: /No onion/ })).toBeDisabled();
    await user.click(within(extras).getByRole('checkbox', { name: /Butter/ }));
    expect(within(extras).getByRole('checkbox', { name: /No onion/ })).toBeEnabled();

    expect(onSelection).toHaveBeenLastCalledWith({
      variantId: 'full',
      modifiers: [{ groupId: 'extras', optionIds: ['cheese'] }],
    });
    await expectNoAxeViolations(container);
  });
});

describe('[MENU-005] ComboChoices', () => {
  it('asks for one item per choice slot', async () => {
    const onChange = vi.fn();
    const { user } = renderUi(
      <ComboChoices
        slots={[
          {
            label: 'Dessert',
            options: [
              { id: 'gj', name: 'Gulab Jamun' },
              { id: 'rm', name: 'Rasmalai' },
            ],
          },
        ]}
        value={[undefined]}
        onChange={onChange}
        rule="Choose one"
        missing="Choose a dessert"
      />,
    );
    const dessert = screen.getByRole('group', { name: 'Dessert' });
    expect(within(dessert).getByText('Choose a dessert')).toBeInTheDocument();
    await user.click(within(dessert).getByRole('radio', { name: 'Rasmalai' }));
    expect(onChange).toHaveBeenCalledWith(['rm']);
  });
});

describe('[NFR-U03] QuantityStepper and ChoiceGroup', () => {
  it('steps within its limits', async () => {
    const onChange = vi.fn();
    const { user, rerender } = renderUi(
      <QuantityStepper
        value={1}
        onChange={onChange}
        max={2}
        label="Quantity of Dal"
        decreaseLabel="Fewer"
        increaseLabel="More"
      />,
    );
    const group = screen.getByRole('group', { name: 'Quantity of Dal' });
    expect(within(group).getByRole('button', { name: 'Fewer' })).toBeDisabled();
    await user.click(within(group).getByRole('button', { name: 'More' }));
    expect(onChange).toHaveBeenCalledWith(2);
    rerender(
      <QuantityStepper
        value={2}
        onChange={onChange}
        max={2}
        label="Quantity of Dal"
        decreaseLabel="Fewer"
        increaseLabel="More"
      />,
    );
    expect(screen.getByRole('button', { name: 'More' })).toBeDisabled();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('links its hint and error to the group', () => {
    renderUi(
      <ChoiceGroup
        legend="Extras"
        hint="Choose 1"
        mode="multiple"
        options={[{ id: 'a', label: 'A' }]}
        value={[]}
        onChange={() => undefined}
        error="Choose at least 1"
      />,
    );
    const group = screen.getByRole('group', { name: 'Extras' });
    expect(group).toHaveAttribute('aria-invalid', 'true');
    expect(group).toHaveAccessibleDescription('Choose 1 Choose at least 1');
  });
});
