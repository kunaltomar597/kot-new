import { mkdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { ApiError, type LoginResponse, PHOTO_MAX_BYTES, PhotoView } from '@rp/contracts';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { PhotosService } from '../../src/photos/photos.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let photos: PhotosService;
let kit: AuthKit;
let manager: LoginResponse;
let waiter: LoginResponse;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  photos = app.get(PhotosService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  waiter = await signIn(app, kit, 'WAITER');
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const server = () => request(httpServer(app));
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;

async function jpeg(width = 1200, height = 900): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#c86428' } })
    .withExif({ IFD0: { Make: 'TestCam', Model: 'Secret Phone' } })
    .jpeg()
    .toBuffer();
}

async function upload(content: Buffer, login = manager): Promise<request.Response> {
  return server()
    .post('/api/v1/photos')
    .set(as(login))
    .send({ contentBase64: content.toString('base64') });
}

describe('[MENU-008] [SEC-004] photo upload', () => {
  it('stores WebP renditions without EXIF and serves them with long caching', async () => {
    const response = await upload(await jpeg());
    expect(response.status).toBe(201);
    const photo = PhotoView.parse(response.body);
    expect(photo).toMatchObject({ mimeType: 'image/webp', width: 960, height: 720 });
    expect(photo.renditions.map((rendition) => rendition.url)).toEqual([
      `/api/v1/photos/${photo.id}/160`,
      `/api/v1/photos/${photo.id}/480`,
      `/api/v1/photos/${photo.id}/960`,
    ]);
    const row = await prisma.photo.findUniqueOrThrow({ where: { id: photo.id } });
    expect(row.restaurantId).toBe(kit.restaurantId);

    // No token: an <img> on any screen loads it.
    const served = await server()
      .get(`/api/v1/photos/${photo.id}/480`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          done(null, Buffer.concat(chunks));
        });
      });
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/webp');
    expect(served.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    const metadata = await sharp(served.body as Buffer).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 480, height: 360 });
    expect(metadata.exif).toBeUndefined();
  });

  it('refuses people without menu rights, non-images and files over 5 MB', async () => {
    const refused = await upload(await jpeg(), waiter);
    expect(refused.status).toBe(403);

    const text = await upload(Buffer.from('<svg onload="alert(1)"></svg>'));
    expect([text.status, codeOf(text)]).toEqual([415, 'PHOTO_UNSUPPORTED']);

    const large = await upload(Buffer.alloc(PHOTO_MAX_BYTES + 1, 1));
    expect([large.status, codeOf(large)]).toEqual([413, 'PHOTO_TOO_LARGE']);

    const notBase64 = await server()
      .post('/api/v1/photos')
      .set(as(manager))
      .send({ contentBase64: 'not base64!' });
    expect(notBase64.status).toBe(400);
  });

  it('answers 404 for an unknown photo and 400 for an unknown width', async () => {
    const unknown = await server().get('/api/v1/photos/0199a0e0-0000-7000-8000-000000000999/160');
    expect([unknown.status, codeOf(unknown)]).toEqual([404, 'PHOTO_NOT_FOUND']);
    const photo = PhotoView.parse((await upload(await jpeg(200, 200))).body);
    expect((await server().get(`/api/v1/photos/${photo.id}/300`)).status).toBe(400);
  });
});

describe('[DATA-007] clean-up of unused photos', () => {
  it('removes old photos nothing uses and stray folders, and keeps the rest', async () => {
    const make = async () => PhotoView.parse((await upload(await jpeg(300, 200))).body).id;
    const [unused, staffPhoto, logo, recent] = [
      await make(),
      await make(),
      await make(),
      await make(),
    ];
    const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await prisma.photo.updateMany({
      where: { id: { in: [unused, staffPhoto, logo] } },
      data: { createdAt: longAgo },
    });
    const staff = await prisma.staff.findFirstOrThrow({
      where: { restaurantId: kit.restaurantId },
    });
    await prisma.staff.update({ where: { id: staff.id }, data: { photoId: staffPhoto } });
    await prisma.restaurant.update({
      where: { id: kit.restaurantId },
      data: { logoPhotoId: logo },
    });
    // Folders of an upload that never got its record: an old one and one still in flight.
    const stray = join(photos.store.root, kit.restaurantId, '0199a0e0-0000-7000-8000-000000000abc');
    const inFlight = join(
      photos.store.root,
      kit.restaurantId,
      '0199a0e0-0000-7000-8000-000000000abd',
    );
    await mkdir(stray, { recursive: true });
    await mkdir(inFlight, { recursive: true });
    await utimes(stray, longAgo, longAgo);

    const result = await photos.purgeUnused();
    expect(result).toMatchObject({ photos: 1, strayFolders: 1 });
    const left = await prisma.photo.findMany({
      where: { id: { in: [unused, staffPhoto, logo, recent] } },
      select: { id: true },
    });
    expect(left.map((photo) => photo.id).sort()).toEqual([staffPhoto, logo, recent].sort());
    expect((await server().get(`/api/v1/photos/${unused}/160`)).status).toBe(404);
    expect((await server().get(`/api/v1/photos/${logo}/160`)).status).toBe(200);
    const keys = await photos.store.keysOnDisk();
    expect(keys).not.toContain(`${kit.restaurantId}/${unused}`);
    expect(keys).not.toContain(`${kit.restaurantId}/0199a0e0-0000-7000-8000-000000000abc`);
    expect(keys).toContain(`${kit.restaurantId}/0199a0e0-0000-7000-8000-000000000abd`);
  });
});
