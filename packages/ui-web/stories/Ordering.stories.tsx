import type { ItemSelection } from '@rp/domain';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { ComboChoices, ItemOptions, MenuItemCard, QuantityStepper } from '../src/index.js';

const meta: Meta = { title: 'Ordering/Gallery' };
export default meta;
type Story = StoryObj;

export const MenuCards: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 11rem)', gap: 12 }}>
      <MenuItemCard
        name="Paneer Tikka"
        price={29_000}
        foodType="VEG"
        foodTypeLabel="Veg"
        note="Choose options"
      />
      <MenuItemCard name="Chicken 65" price={32_000} foodType="NON_VEG" foodTypeLabel="Non-veg" />
      <MenuItemCard
        name="Egg Bhurji"
        price={16_000}
        foodType="EGG"
        foodTypeLabel="Egg"
        note="5 left"
      />
      <MenuItemCard
        name="Gulab Jamun"
        price={9_000}
        foodType="VEG"
        foodTypeLabel="Veg"
        unavailable="Sold out"
      />
    </div>
  ),
};

function OptionsDemo() {
  const [selection, setSelection] = useState<ItemSelection>({});
  const [dessert, setDessert] = useState<(string | undefined)[]>([undefined]);
  const [quantity, setQuantity] = useState(1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 640 }}>
      <ItemOptions
        variants={[
          { id: 'half', name: 'Half', price: 22_000 },
          { id: 'full', name: 'Full', price: 34_000 },
        ]}
        modifierGroups={[
          {
            id: 'spice',
            name: 'Spice level',
            minSelections: 0,
            maxSelections: 1,
            options: [
              { id: 'mild', name: 'Mild', priceDelta: 0 },
              { id: 'hot', name: 'Hot', priceDelta: 0 },
            ],
          },
          {
            id: 'extras',
            name: 'Extras',
            minSelections: 0,
            maxSelections: 2,
            options: [
              { id: 'cheese', name: 'Cheese', priceDelta: 4_000 },
              { id: 'butter', name: 'Butter', priceDelta: 2_000 },
            ],
          },
        ]}
        selection={selection}
        onChange={setSelection}
        labels={{
          variant: 'Size',
          none: 'None',
          rule: (group) => `Optional, up to ${String(group.maxSelections)}`,
        }}
      />
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
        value={dessert}
        onChange={setDessert}
        rule="Choose one"
      />
      <QuantityStepper
        value={quantity}
        onChange={setQuantity}
        label="Quantity"
        decreaseLabel="One fewer"
        increaseLabel="One more"
      />
    </div>
  );
}

export const Options: Story = { render: () => <OptionsDemo /> };
