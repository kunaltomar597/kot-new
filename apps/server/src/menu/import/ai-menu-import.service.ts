import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  AiMenuImportRequest,
  AiMenuImportView,
  MenuImportReport,
  MenuReviewRequest,
} from '@rp/contracts';
import {
  CONTROL_PLANE_ERRORS,
  MENU_EXTRACTION_MAX_BYTES,
  MENU_IMAGE_MAX_BYTES,
  type MenuExtractionFile,
} from '@rp/contracts/control-plane';
import { reviewedMenuSheets, uncheckedDishes } from '@rp/domain';
import sharp from 'sharp';
import { AuditService } from '../../audit/audit.service.js';
import type { Principal } from '../../auth/principal.js';
import { ControlPlaneError } from '../../cloud/control-plane-client.js';
import { HeartbeatService } from '../../cloud/heartbeat.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AppError } from '../../errors/app-error.js';
import { PHOTO_MAX_PIXELS } from '../../photos/photo-processing.js';
import { MenuImportService } from './menu-import.service.js';

/** Long enough to read small print, small enough to send quickly. */
const LONG_EDGE_PX = 2_000;
const JPEG_QUALITY = 82;

const errors = {
  unavailable: (code: string) =>
    new AppError(
      HttpStatus.SERVICE_UNAVAILABLE,
      code,
      code === 'NOT_ENROLLED' || code === 'NOT_CONFIGURED'
        ? 'This PC is not connected to the vendor yet, so menus cannot be read from photos. Use the Excel template.'
        : 'The vendor’s service cannot be reached. Check the internet connection, or use the Excel template.',
    ),
  unreadable: (name: string) =>
    new AppError(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      'PHOTO_UNSUPPORTED',
      `${name} is not a photo we can read. Use JPEG, PNG or WebP photos, or a PDF.`,
    ),
  tooLarge: () =>
    new AppError(
      HttpStatus.PAYLOAD_TOO_LARGE,
      'AI_IMPORT_TOO_LARGE',
      'These files are too large to send together. Send fewer pages at a time.',
    ),
  incomplete: (names: readonly string[]) =>
    new AppError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'MENU_REVIEW_INCOMPLETE',
      `Check every dish before importing: ${String(names.length)} still to check.`,
      { unchecked: names.length, first: names.slice(0, 10) },
    ),
  unknownSetup: () =>
    new AppError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'VALIDATION_FAILED',
      'A tax group or station chosen for a dish is not set up here any more. Choose again.',
    ),
};

/**
 * AI-assisted menu import, the restaurant's side (P6-04b, ONB-006). Photos are turned upright and
 * made smaller here (a phone photo is several megabytes; 2,000 pixels reads fine), then sent to
 * the vendor's Control Plane, which alone holds the AI key (SEC-002) and reads them in the
 * background. The manager's console asks how it is going, shows the draft, and sends it back
 * checked dish by dish: nothing is imported until every dish is checked, and then it goes through
 * the template import (P1-05), with the same checks, audit and publishing.
 */
@Injectable()
export class AiMenuImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloud: HeartbeatService,
    private readonly imports: MenuImportService,
    private readonly audit: AuditService,
  ) {}

  async start(principal: Principal, request: AiMenuImportRequest): Promise<AiMenuImportView> {
    const connection = await this.connection();
    const files = await Promise.all(request.files.map((file) => this.prepare(file)));
    const bytes = files.reduce((total, file) => total + approxBytes(file.contentBase64), 0);
    if (bytes > MENU_EXTRACTION_MAX_BYTES) throw errors.tooLarge();
    const view = await this.vendor(() =>
      connection.client.createMenuExtraction(connection.installationId, { files }),
    );
    await this.prisma.transaction(async (tx) => {
      await this.audit.record(tx, {
        action: 'MENU_AI_IMPORT_STARTED',
        entityType: 'menu',
        entityId: null,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: null,
        after: { importId: view.id, files: files.length, bytes },
        reason: null,
      });
    });
    return view;
  }

  async get(importId: string): Promise<AiMenuImportView> {
    const connection = await this.connection();
    return this.vendor(() =>
      connection.client.getMenuExtraction(connection.installationId, importId),
    );
  }

  /** ONB-006: imports the checked draft, or says what is still to check or wrong. */
  async commit(
    principal: Principal,
    importId: string,
    review: MenuReviewRequest,
  ): Promise<MenuImportReport> {
    const unchecked = uncheckedDishes(review);
    if (unchecked.length > 0) throw errors.incomplete(unchecked);
    const dishes = review.categories.flatMap((category) => category.items);
    const [taxGroups, stations] = await Promise.all([
      this.prisma.taxGroup.findMany({
        where: {
          restaurantId: principal.restaurantId,
          archivedAt: null,
          id: { in: [...new Set(dishes.map((dish) => dish.taxGroupId))] },
        },
        select: { id: true, name: true },
      }),
      this.prisma.station.findMany({
        where: {
          restaurantId: principal.restaurantId,
          archivedAt: null,
          id: { in: [...new Set(dishes.map((dish) => dish.stationId))] },
        },
        select: { id: true, name: true },
      }),
    ]);
    const taxName = new Map(taxGroups.map((group) => [group.id, group.name]));
    const stationName = new Map(stations.map((station) => [station.id, station.name]));
    const sheets = reviewedMenuSheets({
      categories: review.categories.map((category) => ({
        name: category.name,
        items: category.items.map((item) => {
          const taxGroup = taxName.get(item.taxGroupId);
          const station = stationName.get(item.stationId);
          if (taxGroup === undefined || station === undefined) throw errors.unknownSetup();
          return { ...item, taxGroup, station };
        }),
      })),
      addOns: review.addOns,
    });
    return this.imports.commitSheets(principal, sheets, { format: 'AI', importId });
  }

  private async connection() {
    const connection = await this.cloud.connection();
    if ('unavailable' in connection) throw errors.unavailable(connection.unavailable);
    return connection;
  }

  /** The vendor's answers in this API's words. */
  private async vendor<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof ControlPlaneError)) throw error;
      switch (error.code) {
        case 'UNREACHABLE':
          throw errors.unavailable('VENDOR_UNREACHABLE');
        case CONTROL_PLANE_ERRORS.aiImportUnavailable:
          throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, error.code, error.message);
        case CONTROL_PLANE_ERRORS.aiImportLimit:
          throw new AppError(HttpStatus.TOO_MANY_REQUESTS, error.code, error.message);
        case CONTROL_PLANE_ERRORS.menuExtractionNotFound:
          throw new AppError(HttpStatus.NOT_FOUND, 'AI_IMPORT_NOT_FOUND', error.message);
        default:
          throw new AppError(
            HttpStatus.BAD_GATEWAY,
            'VENDOR_ERROR',
            `The vendor’s service could not take this (${error.code}). Try again, or use the Excel template.`,
          );
      }
    }
  }

  /** A photo upright, at most 2,000 pixels on its long edge, as JPEG; a PDF as it is. */
  private async prepare(file: AiMenuImportRequest['files'][number]): Promise<MenuExtractionFile> {
    if (file.contentType === 'application/pdf') return file;
    let content: Buffer;
    try {
      content = await sharp(Buffer.from(file.contentBase64, 'base64'), {
        limitInputPixels: PHOTO_MAX_PIXELS,
      })
        .rotate()
        .resize({
          width: LONG_EDGE_PX,
          height: LONG_EDGE_PX,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();
    } catch {
      throw errors.unreadable(file.name);
    }
    if (content.length > MENU_IMAGE_MAX_BYTES) throw errors.tooLarge();
    return {
      name: file.name,
      contentType: 'image/jpeg',
      contentBase64: content.toString('base64'),
    };
  }
}

const approxBytes = (base64: string) => Math.floor((base64.length * 3) / 4);
