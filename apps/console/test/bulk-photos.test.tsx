import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { draftMenu, NAAN, PANEER, THALI } from './menu-fixture.js';

const PATH = '/manage/menu/photos';
const PHOTO_IDS = [
  '0199a0e0-0000-7000-8000-00000000f001',
  '0199a0e0-0000-7000-8000-00000000f002',
  '0199a0e0-0000-7000-8000-00000000f003',
];

const photoPath = (itemId: string) => `/api/v1/menu/items/${itemId}/photo`;
const setPhoto = (call: { body: unknown }) => ({
  status: 200,
  body: { ...draftMenu().items[0], photoId: (call.body as { photoId: string }).photoId },
});

function photosServer(): FakeServer {
  let uploads = 0;
  return signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/menu/draft', () => ({ status: 200, body: draftMenu() }))
    .on('POST', '/api/v1/photos', () => {
      const id = PHOTO_IDS[uploads] ?? PHOTO_IDS[0];
      uploads += 1;
      return {
        status: 201,
        body: {
          id,
          mimeType: 'image/webp',
          width: 960,
          height: 720,
          renditions: [],
          createdAt: '2026-10-02T10:00:00.000Z',
        },
      };
    })
    .on('PUT', photoPath(PANEER), setPhoto)
    .on('PUT', photoPath(THALI), setPhoto)
    .on('PUT', photoPath(NAAN), setPhoto);
}

const photo = (name: string) => new File(['a photo'], name, { type: 'image/jpeg' });

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
  // jsdom has no object URLs; the previews only need one each.
  URL.createObjectURL = () => 'blob:preview';
  URL.revokeObjectURL = () => undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[ONB-007] adding dish photos in bulk', () => {
  it('matches photos by short code or name, lets a person correct them, then uploads', async () => {
    const fake = photosServer();
    const { user, container } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.upload(await screen.findByLabelText(t('bulkPhotos.files')), [
      photo('PTM.jpg'),
      photo('veg-thali.jpg'),
      photo('IMG_0001.jpg'),
      photo('mango lassi.jpg'),
    ]);
    const list = within(screen.getByRole('list', { name: t('bulkPhotos.files') }));
    const dishFor = (file: string) =>
      list.getByLabelText(new RegExp(`^${t('bulkPhotos.dish', { file }).replace('.', '\\.')}`));
    expect(dishFor('PTM.jpg')).toHaveValue(PANEER);
    expect(dishFor('veg-thali.jpg')).toHaveValue(THALI);
    // Not a dish name, and an archived dish is not offered.
    expect(dishFor('IMG_0001.jpg')).toHaveValue('');
    expect(dishFor('mango lassi.jpg')).toHaveValue('');
    expect(list.getByText(t('bulkPhotos.byCode'))).toBeVisible();
    expect(list.getByText(t('bulkPhotos.byName'))).toBeVisible();
    expect(list.getAllByText(t('bulkPhotos.unmatched'))).toHaveLength(2);
    await expectNoAxeViolations(container);

    await user.selectOptions(dishFor('IMG_0001.jpg'), 'Butter Naan');
    // Choosing a dish another photo has: the first keeps it.
    await user.selectOptions(dishFor('mango lassi.jpg'), 'Butter Naan');
    expect(list.getByText(t('bulkPhotos.taken'))).toBeVisible();
    await user.click(
      list.getByRole('button', { name: t('bulkPhotos.remove', { file: 'mango lassi.jpg' }) }),
    );

    await user.click(screen.getByRole('button', { name: t('bulkPhotos.upload', { count: 3 }) }));
    await waitFor(() => {
      expect(fake.callsTo('PUT', photoPath(NAAN))).toHaveLength(1);
    });
    expect(fake.callsTo('POST', '/api/v1/photos')[0]?.body).toEqual({
      contentBase64: 'YSBwaG90bw==',
    });
    expect([PANEER, THALI, NAAN].map((id) => fake.callsTo('PUT', photoPath(id))[0]?.body)).toEqual([
      { photoId: PHOTO_IDS[0] },
      { photoId: PHOTO_IDS[1] },
      { photoId: PHOTO_IDS[2] },
    ]);
    expect(await screen.findAllByText(t('bulkPhotos.uploaded'))).toHaveLength(3);
    expect(
      screen.getAllByText(new RegExp(t('bulkPhotos.done', { count: 3 }).slice(0, 20))).length,
    ).toBeGreaterThan(0);
  });
});
