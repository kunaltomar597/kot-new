import type { StorybookConfig } from '@storybook/react-vite';

// Component workbench (ADR-0009). Run `pnpm --filter @rp/ui-web workbench`.
const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../stories/**/*.stories.tsx'],
  core: { disableTelemetry: true },
};

export default config;
