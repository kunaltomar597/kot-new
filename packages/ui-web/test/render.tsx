import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { type UserEvent, userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import type { ReactElement, ReactNode } from 'react';
import { expect } from 'vitest';
import { EN_STRINGS } from '../fixtures/en-strings.js';
import { ThemeRoot } from '../src/components/ThemeRoot.js';
import { UiStringsProvider } from '../src/strings.js';
import type { ThemeName } from '@rp/design-tokens';

/** Renders inside the providers every app sets up, and returns a user-event instance. */
export function renderUi(
  ui: ReactElement,
  { theme = 'light', ...options }: RenderOptions & { theme?: ThemeName } = {},
): RenderResult & { user: UserEvent } {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <UiStringsProvider strings={EN_STRINGS}>
      <ThemeRoot theme={theme}>{children}</ThemeRoot>
    </UiStringsProvider>
  );
  const user = userEvent.setup();
  return { user, ...render(ui, { wrapper, ...options }) };
}

/**
 * Runs axe-core on a container and fails with a readable list of violations. Colour contrast is
 * skipped because jsdom does not compute styles; token contrast is tested in @rp/design-tokens.
 */
export async function expectNoAxeViolations(container: Element): Promise<void> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false } },
  });
  const summary = results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(' ')).join(', ')})`,
  );
  expect(summary).toEqual([]);
}
