import { describe, expect, it } from 'vitest';
import {
  CloudBackupFileName,
  cloudFileKindOf,
  MenuExtractionFile,
  MenuExtractionRequest,
  PlanPrices,
  UpdateVendorUserRequest,
} from '../src/control-plane/index.js';
import {
  AI_IMPORT_IMAGE_MAX_BYTES,
  AI_IMPORT_PDF_MAX_BYTES,
  AiMenuImportRequest,
  ApproveAtTableRequest,
  ApproveOrderRequest,
  ArchivedInvoiceQuery,
  AuditListQuery,
  IndianMobile,
  ITEM_PREFERENCES_MAX,
  photoUrl,
  PrinterRequest,
  StationRequest,
  TabletFeedbackRequest,
} from '../src/index.js';
import { QrRecommendations } from '../src/relay/index.js';

/**
 * The checks inside request schemas that span more than one field (Zod refinements): each with a
 * request it takes and one it refuses, so a refinement that stops refusing is caught.
 */

const ID = '0199a0e0-0000-7000-8000-000000000001';

/** Base64 text standing for `bytes` bytes. */
const base64Of = (bytes: number) => 'A'.repeat(Math.ceil((bytes * 4) / 3 / 4) * 4);

describe('[DATA-008] finding invoices in an archive', () => {
  it('takes a business date or an invoice number, not both or neither', () => {
    expect(ArchivedInvoiceQuery.safeParse({ date: '2026-04-01' }).success).toBe(true);
    expect(ArchivedInvoiceQuery.safeParse({ number: 'INV/26-27/000001' }).success).toBe(true);
    expect(ArchivedInvoiceQuery.safeParse({}).success).toBe(false);
    expect(
      ArchivedInvoiceQuery.safeParse({ date: '2026-04-01', number: 'INV/26-27/000001' }).success,
    ).toBe(false);
  });
});

describe('[AUD-005] the audit viewer’s range', () => {
  it('runs forwards and covers at most 366 days', () => {
    expect(AuditListQuery.safeParse({ from: '2026-01-01', to: '2026-12-31' }).success).toBe(true);
    expect(AuditListQuery.safeParse({ from: '2026-02-01', to: '2026-01-01' }).success).toBe(false);
    expect(AuditListQuery.safeParse({ from: '2025-01-01', to: '2026-01-02' }).success).toBe(false);
  });
});

describe('[SEC-019] a diner’s number with the feedback', () => {
  it('takes Indian mobile numbers only', () => {
    expect(IndianMobile.safeParse('+91 98765-43210').success).toBe(true);
    expect(IndianMobile.safeParse('9876543210').success).toBe(true);
    expect(IndianMobile.safeParse('5876543210').success).toBe(false);
  });

  it('keeps a number only with the diner’s consent and its words', () => {
    const base = { foodRating: 5, serviceRating: 4 };
    expect(TabletFeedbackRequest.safeParse(base).success).toBe(true);
    expect(
      TabletFeedbackRequest.safeParse({
        ...base,
        phone: '9876543210',
        consent: true,
        consentText: 'Send me my bill and ask for feedback',
      }).success,
    ).toBe(true);
    expect(TabletFeedbackRequest.safeParse({ ...base, phone: '9876543210' }).success).toBe(false);
  });
});

describe('[ONB-006] menus read by the AI', () => {
  const file = (contentType: string, bytes: number) => ({
    name: 'menu',
    contentType,
    contentBase64: base64Of(bytes),
  });

  it('limits each photo and PDF, and all files together, on the restaurant PC', () => {
    expect(AiMenuImportRequest.safeParse({ files: [file('image/jpeg', 1_000)] }).success).toBe(
      true,
    );
    expect(
      AiMenuImportRequest.safeParse({
        files: [file('image/jpeg', AI_IMPORT_IMAGE_MAX_BYTES + 1_024)],
      }).success,
    ).toBe(false);
    expect(
      AiMenuImportRequest.safeParse({
        files: [file('application/pdf', AI_IMPORT_IMAGE_MAX_BYTES + 1_024)],
      }).success,
    ).toBe(true);
    expect(
      AiMenuImportRequest.safeParse({
        files: [
          file('application/pdf', AI_IMPORT_PDF_MAX_BYTES - 1_024),
          file('application/pdf', AI_IMPORT_PDF_MAX_BYTES - 1_024),
          file('image/png', 1_000_000),
        ],
      }).success,
    ).toBe(false);
  });

  it('limits each photo, and all files together, at the Control Plane', () => {
    expect(MenuExtractionFile.safeParse(file('image/webp', 1_000)).success).toBe(true);
    expect(MenuExtractionFile.safeParse(file('image/webp', 6 * 1024 * 1024)).success).toBe(false);
    expect(MenuExtractionFile.safeParse(file('application/pdf', 6 * 1024 * 1024)).success).toBe(
      true,
    );
    expect(
      MenuExtractionRequest.safeParse({
        files: [
          file('application/pdf', 11 * 1024 * 1024),
          file('application/pdf', 11 * 1024 * 1024),
        ],
      }).success,
    ).toBe(false);
  });
});

describe('[ORD-003] [ORD-004] changing a diner’s order before approving it', () => {
  it('needs the diner’s agreement for a change', () => {
    const changes = [{ orderItemId: ID, quantity: 1 }];
    expect(ApproveOrderRequest.safeParse({}).success).toBe(true);
    expect(ApproveOrderRequest.safeParse({ changes, dinerAgreed: true }).success).toBe(true);
    expect(ApproveOrderRequest.safeParse({ changes }).success).toBe(false);
    expect(ApproveAtTableRequest.safeParse({ staffId: ID, pin: '4444', changes }).success).toBe(
      false,
    );
  });
});

describe('[MENU-008] photo addresses', () => {
  it('points at a rendition of the photo', () => {
    expect(photoUrl(ID, 480)).toBe(`/api/v1/photos/${ID}/480`);
  });
});

describe('[KDS-002] [KDS-008] stations and printers', () => {
  it('needs a printer for a station that prints', () => {
    expect(StationRequest.safeParse({ name: 'Bar', mode: 'SCREEN', printerId: null }).success).toBe(
      true,
    );
    expect(StationRequest.safeParse({ name: 'Bar', mode: 'PRINT', printerId: null }).success).toBe(
      false,
    );
  });

  it('needs a port and a host for a network printer, and a share name for a USB one', () => {
    const network = {
      name: 'Kitchen',
      connection: 'NETWORK',
      host: '192.168.1.50',
      port: 9100,
      paperWidthMm: 80,
    };
    expect(PrinterRequest.safeParse(network).success).toBe(true);
    expect(PrinterRequest.safeParse({ ...network, port: null }).success).toBe(false);
    expect(PrinterRequest.safeParse({ ...network, host: 'bad host!' }).success).toBe(false);
    const usb = { ...network, connection: 'USB', host: 'Kitchen printer', port: null };
    expect(PrinterRequest.safeParse(usb).success).toBe(true);
    expect(PrinterRequest.safeParse({ ...usb, host: '/dev/usb/lp0' }).success).toBe(true);
    expect(PrinterRequest.safeParse({ ...usb, host: '\\\\pc\\share' }).success).toBe(false);
  });
});

describe('[VCP-003] [VCP-001] plans and vendor staff at the Control Plane', () => {
  it('offers a plan on at least one billing cycle', () => {
    expect(PlanPrices.safeParse({ MONTHLY: 99_900, QUARTERLY: null, YEARLY: null }).success).toBe(
      true,
    );
    expect(PlanPrices.safeParse({ MONTHLY: null, QUARTERLY: null, YEARLY: null }).success).toBe(
      false,
    );
  });

  it('changes a vendor account’s role or whether it is disabled', () => {
    expect(UpdateVendorUserRequest.safeParse({ disabled: true, reason: 'Left' }).success).toBe(
      true,
    );
    expect(UpdateVendorUserRequest.safeParse({ reason: 'Nothing to change' }).success).toBe(false);
  });
});

describe('[DATA-003] files in the cloud backup', () => {
  it('takes backup and archive file names only, and tells them apart', () => {
    const backup = 'rp-backup-20261005T013000Z-nightly.rpbk';
    const archive = 'rp-archive-FY2025-26-20261005T013000Z.rpar';
    expect(CloudBackupFileName.safeParse(backup).success).toBe(true);
    expect(CloudBackupFileName.safeParse(archive).success).toBe(true);
    expect(CloudBackupFileName.safeParse('../etc/passwd').success).toBe(false);
    expect(cloudFileKindOf(backup)).toBe('BACKUP');
    expect(cloudFileKindOf(archive)).toBe('ARCHIVE');
  });
});

describe('[REC-009] the QR menu’s pinned, boosted and blocked dishes', () => {
  it('keeps at most the dishes the restaurant may set', () => {
    const preferences = QrRecommendations.shape.preferences;
    expect(preferences.safeParse({ [ID]: 'PIN' }).success).toBe(true);
    const tooMany = Object.fromEntries(
      Array.from({ length: ITEM_PREFERENCES_MAX + 1 }, (_, index) => [
        `0199a0e0-0000-7000-8000-${String(index).padStart(12, '0')}`,
        'BOOST',
      ]),
    );
    expect(preferences.safeParse(tooMany).success).toBe(false);
  });
});
