import { HELP_TOPICS } from '../src/help/help-topics.js';
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { markSeen, seenTopics, topicForPath } from '../src/help/help-topics.js';
import { FLOOR, OVERVIEW, SERVICE } from './dashboard-fixture.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';

class FakeStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

describe('[NFR-U07] help topics', () => {
  it('maps dashboard paths to topics', () => {
    expect(topicForPath('/manage')).toBe('overview');
    expect(topicForPath('/manage/')).toBe('overview');
    expect(topicForPath('/manage/menu/photos')).toBe('menu');
    expect(topicForPath('/manage/qr-codes')).toBe('qrCodes');
    expect(topicForPath('/manage/nowhere')).toBeUndefined();
    expect(topicForPath('/pos')).toBeUndefined();
  });

  it('has help text for every topic', () => {
    for (const topic of HELP_TOPICS) {
      for (const part of ['title', 'body', 'tip'] as const) {
        expect(t(`help.${topic}.${part}`).length).toBeGreaterThan(5);
      }
    }
  });

  it('remembers what each person has seen, and survives bad or blocked storage', () => {
    const storage = new FakeStorage();
    markSeen(storage, 'p1', 'menu');
    markSeen(storage, 'p1', 'orders');
    expect([...seenTopics(storage, 'p1')].sort()).toEqual(['menu', 'orders']);
    expect(seenTopics(storage, 'p2').size).toBe(0);
    storage.setItem('rp-console.tips-seen.p3', '{not json');
    expect(seenTopics(storage, 'p3').size).toBe(0);
    expect(() => {
      markSeen(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error('full');
          },
        },
        'p1',
        'menu',
      );
    }).not.toThrow();
  });
});

describe('[NFR-U07] help on the dashboard', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  const managerServer = () =>
    signsInAs(server(), 'MANAGER')
      .on('GET', '/api/v1/floor', () => ({ status: 200, body: FLOOR }))
      .on('GET', '/api/v1/tables/overview', () => ({ status: 200, body: OVERVIEW }))
      .on('GET', '/api/v1/order-feed', () => ({ status: 200, body: SERVICE }))
      .on('GET', '/api/v1/alerts', () => ({ status: 200, body: { alerts: [] } }));

  it('shows a tip once, then only the Help button', async () => {
    const fake = managerServer();
    const { user, container } = await renderConsole({ fake, path: '/manage', signedIn: 'MANAGER' });
    const tip = await screen.findByRole('complementary', { name: t('help.tipLabel') });
    expect(tip.textContent).toContain(t('help.overview.tip'));
    await expectNoAxeViolations(container);
    await user.click(within(tip).getByRole('button', { name: t('help.gotIt') }));
    expect(screen.queryByRole('complementary', { name: t('help.tipLabel') })).toBeNull();

    await user.click(screen.getByRole('button', { name: t('help.button') }));
    const dialog = await screen.findByRole('dialog', { name: t('help.overview.title') });
    expect(dialog.textContent).toContain(t('help.overview.body'));
  });

  it('does not show the tip again to a person who has seen it', async () => {
    const first = await renderConsole({
      fake: managerServer(),
      path: '/manage',
      signedIn: 'MANAGER',
    });
    await first.user.click(
      within(await screen.findByRole('complementary', { name: t('help.tipLabel') })).getByRole(
        'button',
        { name: t('help.gotIt') },
      ),
    );
    first.unmount();
    await renderConsole({ fake: managerServer(), path: '/manage', signedIn: 'MANAGER' });
    await screen.findByRole('button', { name: t('help.button') });
    expect(screen.queryByRole('complementary', { name: t('help.tipLabel') })).toBeNull();
  });
});
