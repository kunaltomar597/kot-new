import {
  type ItemSelection,
  type ModifierGroupDef,
  type SelectionIssue,
  unitPriceOf,
  validateSelection,
} from '@rp/domain';
import { fireEvent, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { Text } from 'react-native';
import {
  ChoiceGroup,
  ComboChoices,
  ItemOptions,
  MenuItemCard,
  QuantityStepper,
} from '../src/index.js';
import { renderUi } from './render.js';

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
const ITEM = {
  id: 'tikka',
  basePrice: 18_000,
  variants: [HALF, FULL],
  modifierGroups: [SPICE, EXTRAS],
};
const LABELS = {
  variant: 'Size',
  none: 'None',
  rule: (group: ModifierGroupDef) =>
    group.minSelections === 0
      ? `Optional, up to ${String(group.maxSelections)}`
      : `Choose ${String(group.minSelections)} to ${String(group.maxSelections)}`,
};

describe('[MENU-012] MenuItemCard', () => {
  it('speaks name, price, food type and note, and selects on press', async () => {
    const onSelect = jest.fn();
    await renderUi(
      <MenuItemCard
        name="Paneer Tikka"
        price={28_000}
        foodType="VEG"
        foodTypeLabel="Veg"
        note="Choose options"
        onSelect={onSelect}
      />,
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Paneer Tikka, ₹280.00, Veg, Choose options' }),
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('food-VEG')).toBeOnTheScreen();
  });

  it('is disabled with the reason when it cannot be ordered', async () => {
    await renderUi(
      <MenuItemCard
        name="Egg Curry"
        price={16_000}
        foodType="EGG"
        foodTypeLabel="Egg"
        note="3 left"
        unavailable="Sold out"
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Egg Curry, ₹160.00, Egg, Sold out' }),
    ).toBeDisabled();
    expect(screen.queryByText('3 left')).toBeNull();
  });
});

describe('[NFR-U03] QuantityStepper', () => {
  function Stepper() {
    const [value, setValue] = useState(1);
    return (
      <QuantityStepper
        value={value}
        onChange={setValue}
        max={2}
        label="Quantity of Dal"
        decreaseLabel="Fewer"
        increaseLabel="More"
      />
    );
  }

  it('steps within the limits', async () => {
    await renderUi(<Stepper />);
    expect(screen.getByRole('button', { name: 'Fewer' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByTestId('stepper-value')).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: 'More' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Fewer' }));
    expect(screen.getByTestId('stepper-value')).toHaveTextContent('1');
  });
});

describe('[MENU-003][MENU-004] ItemOptions', () => {
  function Options({ issues }: { issues?: readonly SelectionIssue[] }) {
    const [selection, setSelection] = useState<ItemSelection>({});
    const valid = validateSelection(ITEM, selection).length === 0;
    return (
      <>
        <ItemOptions
          variants={ITEM.variants}
          modifierGroups={ITEM.modifierGroups}
          selection={selection}
          onChange={setSelection}
          labels={LABELS}
          issues={issues}
        />
        <Text testID="price">{valid ? String(unitPriceOf(ITEM, selection)) : 'invalid'}</Text>
      </>
    );
  }

  it('builds a selection the domain prices, with the same rules as the server', async () => {
    await renderUi(<Options />);
    expect(screen.getByTestId('price')).toHaveTextContent('invalid');
    await fireEvent.press(screen.getByRole('radio', { name: 'Full, ₹280.00' }));
    expect(screen.getByRole('radio', { name: 'Full, ₹280.00' })).toBeChecked();
    // Optional single choice starts at "None".
    expect(screen.getByRole('radio', { name: 'None' })).toBeChecked();
    await fireEvent.press(screen.getByRole('radio', { name: 'Hot' }));
    expect(screen.getByRole('radio', { name: 'None' })).not.toBeChecked();
    await fireEvent.press(screen.getByRole('checkbox', { name: 'Cheese, +₹40.00' }));
    await fireEvent.press(screen.getByRole('checkbox', { name: 'No onion, -₹5.00' }));
    expect(screen.getByTestId('price')).toHaveTextContent('31500');
    // The group is full at two: the third option waits until one is unticked.
    expect(screen.getByRole('checkbox', { name: 'Butter, +₹20.00' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('checkbox', { name: 'Cheese, +₹40.00' }));
    expect(screen.getByRole('checkbox', { name: 'Butter, +₹20.00' })).toBeEnabled();
    await fireEvent.press(screen.getByRole('checkbox', { name: 'No onion, -₹5.00' }));
    expect(screen.getByTestId('price')).toHaveTextContent('invalid');
    await fireEvent.press(screen.getByRole('radio', { name: 'None' }));
    expect(screen.getByText('Optional, up to 1')).toBeOnTheScreen();
    expect(screen.getByText('Choose 1 to 2')).toBeOnTheScreen();
  });

  it('shows the problems from validateSelection by group', async () => {
    const issues = validateSelection(ITEM, {});
    await renderUi(<Options issues={issues} />);
    expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(2);
    await renderUi(
      <ItemOptions
        variants={[]}
        modifierGroups={[EXTRAS]}
        selection={{}}
        onChange={jest.fn()}
        labels={{ ...LABELS, issue: () => 'Choose at least one extra' }}
        issues={validateSelection({ ...ITEM, variants: [], modifierGroups: [EXTRAS] }, {})}
      />,
    );
    expect(screen.getByText('Choose at least one extra')).toBeOnTheScreen();
    expect(screen.queryByText('Size')).toBeNull();
  });
});

describe('[MENU-005] ComboChoices', () => {
  function Combo({ missing }: { missing?: string }) {
    const [value, setValue] = useState<(string | undefined)[]>([]);
    return (
      <>
        <ComboChoices
          slots={[
            { label: 'Main', options: [{ id: 'dal', name: 'Dal' }] },
            {
              label: 'Dessert',
              options: [
                { id: 'kheer', name: 'Kheer' },
                { id: 'jamun', name: 'Gulab Jamun' },
              ],
            },
          ]}
          value={value}
          onChange={setValue}
          rule="Choose one"
          {...(missing !== undefined && { missing })}
        />
        <Text testID="combo">{value.map((id) => id ?? '-').join(',')}</Text>
      </>
    );
  }

  it('keeps one choice per slot in slot order', async () => {
    await renderUi(<Combo />);
    await fireEvent.press(screen.getByRole('radio', { name: 'Kheer' }));
    expect(screen.getByTestId('combo')).toHaveTextContent('-,kheer');
    await fireEvent.press(screen.getByRole('radio', { name: 'Dal' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'Gulab Jamun' }));
    expect(screen.getByTestId('combo')).toHaveTextContent('dal,jamun');
  });

  it('marks the empty slots once the person tries to add', async () => {
    await renderUi(<Combo missing="Pick one" />);
    expect(screen.getAllByText('Pick one')).toHaveLength(2);
  });
});

describe('ChoiceGroup', () => {
  it('honours disabled options', async () => {
    const onChange = jest.fn();
    await renderUi(
      <ChoiceGroup
        legend="Table"
        mode="multiple"
        options={[{ id: 't1', label: 'T1', disabled: true }]}
        value={[]}
        onChange={onChange}
      />,
    );
    await fireEvent.press(screen.getByRole('checkbox', { name: 'T1' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
