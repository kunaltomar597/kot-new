import type { Meta, StoryObj } from '@storybook/react-vite';
import { BUTTON_VARIANTS, Button, Icon, IconButton } from '../src/index.js';

const meta: Meta<typeof Button> = {
  title: 'Actions/Button',
  component: Button,
  args: { children: 'Send KOT', variant: 'primary', size: 'md' },
};
export default meta;
type Story = StoryObj<typeof Button>;

export const Playground: Story = {};

export const Variants: Story = {
  render: (args) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      {BUTTON_VARIANTS.map((variant) => (
        <Button key={variant} {...args} variant={variant}>
          {variant}
        </Button>
      ))}
      <Button {...args} disabled>
        Disabled
      </Button>
      <Button {...args} loading>
        Sending…
      </Button>
      <Button {...args} size="lg" startIcon={<Icon name="plus" />}>
        Add item
      </Button>
    </div>
  ),
};

export const IconButtons: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 12 }}>
      <IconButton label="Close" icon={<Icon name="close" />} />
      <IconButton label="Refresh" icon={<Icon name="sync" />} variant="secondary" />
      <IconButton label="Add" icon={<Icon name="plus" />} variant="primary" size="lg" />
      <IconButton label="Remove" icon={<Icon name="minus" />} variant="danger" />
    </div>
  ),
};
