import { THEME_NAMES } from '@rp/design-tokens';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge, Button, Card, Money, PinPad, StatusChip, ThemeRoot } from '../src/index.js';

const meta: Meta = { title: 'Foundations/Themes', parameters: { layout: 'fullscreen' } };
export default meta;
type Story = StoryObj;

/** Light, dark and KDS side by side: the acceptance check that everything renders in each. */
export const AllThemes: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
      {THEME_NAMES.map((theme) => (
        <ThemeRoot key={theme} theme={theme} style={{ padding: 24 }} data-testid={`theme-${theme}`}>
          <Card title={theme} actions={<Badge tone="info">{theme}</Badge>}>
            <div style={{ display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button>Primary</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="danger">Void</Button>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <StatusChip state="PENDING_APPROVAL" label="Awaiting approval" />
                <StatusChip state="READY" label="Ready" />
                <StatusChip state="VOIDED" label="Voided" />
              </div>
              <Money paise={123_450} size="lg" strong />
              <PinPad label={`PIN (${theme})`} onComplete={() => undefined} />
            </div>
          </Card>
        </ThemeRoot>
      ))}
    </div>
  ),
};
