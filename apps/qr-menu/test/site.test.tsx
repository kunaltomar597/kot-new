import '@testing-library/jest-dom/vitest';
import type { MenuItem } from '@rp/contracts';
import type { QrOrderView } from '@rp/contracts/relay';
import { en } from '@rp/i18n';
import { IDS, MENU } from '@rp/ordering/testing';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DishPhoto } from '../src/site/DishPhoto';
import { I18nProvider } from '../src/site/i18n';
import { Orders } from '../src/site/Orders';
import { browserId, tableValue } from '../src/site/storage';
import { contentSecurityPolicy, newNonce } from '../src/proxy';

beforeEach(() => {
  window.localStorage.clear();
});

describe('[QR-013] what the browser may load', () => {
  it('allows this site and the relay only', () => {
    const csp = contentSecurityPolicy('https://abc.supabase.co', newNonce());
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' https://abc.supabase.co");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/https:\/\/(?!abc\.supabase\.co)/);
  });

  it('[SEC-017] runs scripts with the request’s nonce only, never inline ones', () => {
    const nonce = newNonce();
    const csp = contentSecurityPolicy('https://abc.supabase.co', nonce);
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}';`);
    expect(csp).not.toContain('strict-dynamic');
    expect(csp).toContain(`style-src 'self' 'nonce-${nonce}'`);
    // Only style attributes (the accent colour) are inline, and they run nothing.
    expect(csp.match(/'unsafe-inline'/g)).toEqual(["'unsafe-inline'"]);
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
    expect(csp).not.toContain('unsafe-eval');
    // A new nonce for each request: 128 random bits in base64, as Next.js reads it.
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(new Set(Array.from({ length: 50 }, newNonce)).size).toBe(50);
  });
});

describe('[MENU-008] [QR-012] a dish’s photo', () => {
  const photo = {
    photoId: IDS.dal,
    sizes: [
      { width: 160, height: 120, path: 'tenant/photo/160.webp' },
      { width: 480, height: 360, path: 'tenant/photo/480.webp' },
    ],
  };
  const base = 'https://abc.supabase.co/storage/v1/object/public/menu-photos';

  it('lets the browser pick the size it needs, lazily, and says nothing to a screen reader', () => {
    const { container } = render(
      <DishPhoto photo={photo} base={base} sizes="4.5rem" className="qr-dish__photo" />,
    );
    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', `${base}/tenant/photo/160.webp`);
    expect(image).toHaveAttribute(
      'srcset',
      `${base}/tenant/photo/160.webp 160w, ${base}/tenant/photo/480.webp 480w`,
    );
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveAttribute('alt', '');
    expect(image).toHaveAttribute('width', '160');
  });

  it('shows nothing without a photo or when the relay keeps none', () => {
    const none = render(<DishPhoto photo={undefined} base={base} sizes="1rem" className="x" />);
    expect(none.container).toBeEmptyDOMElement();
    const off = render(<DishPhoto photo={photo} base={null} sizes="1rem" className="x" />);
    expect(off.container).toBeEmptyDOMElement();
  });
});

describe('[QR-006] [QR-013] what the browser keeps', () => {
  it('keeps one anonymous id for the rate limit', () => {
    const id = browserId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(browserId()).toBe(id);
  });

  it('keeps the cart per table, without the whole code, and survives bad data', () => {
    const token = 'AbCdEfGhIjKlMnOpQrStUv';
    const cart = tableValue<readonly string[]>(
      token,
      'cart',
      (value) => (Array.isArray(value) ? (value as string[]) : undefined),
      [],
    );
    cart.set(['a']);
    expect(Object.keys(window.localStorage).join()).not.toContain(token);
    const again = tableValue<readonly string[]>(
      token,
      'cart',
      (value) => (Array.isArray(value) ? (value as string[]) : undefined),
      [],
    );
    expect(again.get()).toEqual(['a']);
    window.localStorage.setItem('rp.qr.cart.v1.AbCdEfGh', '{not json');
    const broken = tableValue<readonly string[]>(token, 'cart', () => undefined, []);
    expect(broken.get()).toEqual([]);
  });
});

describe('[QR-007] where an order is', () => {
  const items = new Map<string, MenuItem>(MENU.items.map((item) => [item.id, item]));
  const order = (overrides: Partial<QrOrderView>): QrOrderView => ({
    id: '0199a0e0-0000-7000-8000-000000000a01',
    status: 'SUBMITTED',
    submittedAt: '2026-10-02T08:00:00.000Z',
    expiresAt: '2026-10-02T08:01:00.000Z',
    lines: [
      {
        clientLineId: '0199a0e0-0000-7000-8000-000000000b01',
        itemId: IDS.dal,
        quantity: 2,
        modifiers: [],
      },
    ],
    orderNote: null,
    customerName: null,
    detail: {},
    ...overrides,
  });
  const show = (orders: QrOrderView[], now: number) =>
    render(
      <I18nProvider>
        <Orders orders={orders} items={items} now={now} />
      </I18nProvider>,
    );

  it('says it is on its way, and says to call a waiter once the pickup time passed', () => {
    const { rerender } = show([order({})], Date.parse('2026-10-02T08:00:30.000Z'));
    expect(screen.getByText(en.qrSite.orders.SUBMITTED)).toBeVisible();
    expect(screen.getByText('2 × Dal Makhani')).toBeVisible();
    rerender(
      <I18nProvider>
        <Orders orders={[order({})]} items={items} now={Date.parse('2026-10-02T08:01:01.000Z')} />
      </I18nProvider>,
    );
    expect(screen.getByText(en.qrSite.orders.EXPIRED)).toBeVisible();
  });

  it('shows each dish’s state in the kitchen, and why an order was not taken', () => {
    show(
      [
        order({
          status: 'SENT_TO_KITCHEN',
          detail: {
            items: [{ clientLineId: '0199a0e0-0000-7000-8000-000000000b01', state: 'READY' }],
          },
        }),
        order({
          id: '0199a0e0-0000-7000-8000-000000000a02',
          status: 'REJECTED',
          detail: { rejectionReason: 'The kitchen is closing' },
        }),
      ],
      Date.parse('2026-10-02T08:00:30.000Z'),
    );
    expect(screen.getByText(en.qrSite.orders.SENT_TO_KITCHEN)).toBeVisible();
    expect(screen.getByText(en.qrSite.orders.itemState.READY)).toBeVisible();
    expect(screen.getByText('Reason: The kitchen is closing')).toBeVisible();
  });
});
