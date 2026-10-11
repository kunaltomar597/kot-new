import type { TableQrCodesResponse } from '@rp/contracts';
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';

const PATH = '/manage/qr-codes';
const SITE = 'https://menu.example.in';
const T1 = '0199a0e0-0000-7000-8000-000000000101';
const T2 = '0199a0e0-0000-7000-8000-000000000102';

function codes(withCodes: boolean, siteUrl: string | null = SITE): TableQrCodesResponse {
  return {
    siteUrl,
    tables: [
      {
        tableId: T1,
        label: 'T1',
        sectionName: 'Hall',
        hasCode: withCodes,
        url: withCodes && siteUrl !== null ? `${siteUrl}/t/AAAAAAAAAAAAAAAAAAAAAA` : null,
        issuedAt: withCodes ? '2026-10-02T08:00:00.000Z' : null,
      },
      {
        tableId: T2,
        label: 'T2',
        sectionName: 'Hall',
        hasCode: withCodes,
        url: withCodes && siteUrl !== null ? `${siteUrl}/t/BBBBBBBBBBBBBBBBBBBBBB` : null,
        issuedAt: withCodes ? '2026-10-02T08:00:00.000Z' : null,
      },
    ],
  };
}

function qrServer(...answers: TableQrCodesResponse[]): FakeServer {
  return signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/tables/qr-codes', ...answers.map((body) => () => ({ status: 200, body })))
    .on('POST', '/api/v1/tables/qr-codes', () => ({ status: 200, body: codes(true) }))
    .on('POST', `/api/v1/tables/${T1}/qr-code`, () => ({
      status: 200,
      body: { ...codes(true).tables[0], url: `${SITE}/t/CCCCCCCCCCCCCCCCCCCCCC` },
    }))
    .on('POST', '/api/v1/tables/qr-codes/tents', () => ({
      status: 200,
      body: {
        filename: 'table-tents_A5_2026-10-02.pdf',
        contentType: 'application/pdf',
        encoding: 'base64',
        content: btoa('%PDF-1.3 test'),
        pages: 2,
      },
    }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[QR-001] [ONB-004] table QR codes', () => {
  it('makes the missing codes in one step, then prints the tents', async () => {
    const createObjectURL = vi.fn((_file: Blob) => 'blob:tents');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const fake = qrServer(codes(false), codes(true));
    const { container, user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    expect(await screen.findByText(t('qrCodes.missing', { count: 2 }))).toBeVisible();
    expect(screen.getAllByText(t('qrCodes.noCode'))).toHaveLength(2);
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: t('qrCodes.issue', { count: 2 }) }));
    expect(await screen.findByText(t('qrCodes.issued'))).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/tables/qr-codes')).toHaveLength(1);
    await screen.findByRole('button', { name: t('qrCodes.showOf', { label: 'T1' }) });

    await user.click(screen.getByRole('radio', { name: t('qrCodes.sizes.A5') }));
    await user.click(screen.getByRole('button', { name: t('qrCodes.print') }));
    expect(
      await screen.findByText(t('qrCodes.printed', { file: 'table-tents_A5_2026-10-02.pdf' })),
    ).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/tables/qr-codes/tents')[0]?.body).toEqual({ size: 'A5' });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('shows a table’s code, and gives it a new one with a reason', async () => {
    const fake = qrServer(codes(true), codes(true));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      await screen.findByRole('button', { name: t('qrCodes.showOf', { label: 'T1' }) }),
    );
    const shown = await screen.findByRole('dialog', { name: t('qrCodes.table', { label: 'T1' }) });
    expect(
      within(shown).getByRole('img', { name: t('qrCodes.codeOf', { label: 'T1' }) }),
    ).toBeVisible();
    expect(within(shown).getByText(`${SITE}/t/AAAAAAAAAAAAAAAAAAAAAA`)).toBeVisible();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: t('qrCodes.newOf', { label: 'T1' }) }));
    const dialog = await screen.findByRole('dialog', { name: t('qrCodes.newOf', { label: 'T1' }) });
    expect(within(dialog).getByText(t('qrCodes.newWarning', { label: 'T1' }))).toBeVisible();
    const confirm = within(dialog).getByRole('button', { name: t('qrCodes.newConfirm') });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(t('qrCodes.reason')), 'Code was photographed');
    await user.click(confirm);
    expect(await screen.findByText(t('qrCodes.regenerated', { label: 'T1' }))).toBeVisible();
    expect(fake.callsTo('POST', `/api/v1/tables/${T1}/qr-code`)[0]?.body).toEqual({
      reason: 'Code was photographed',
    });
  });

  it('says codes cannot be printed until the QR site is set', async () => {
    const fake = qrServer(codes(true, null));
    await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    expect(await screen.findByText(t('qrCodes.noSite'))).toBeVisible();
    expect(screen.getByRole('button', { name: t('qrCodes.print') })).toBeDisabled();
  });
});
