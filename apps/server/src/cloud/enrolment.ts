import { EnrolmentCode } from '@rp/contracts/control-plane';
import type { Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { SecretStore } from '../auth/secret-store.js';
import type { AppConfig } from '../config/app-config.js';
import type { PrismaService } from '../database/prisma.service.js';
import { ControlPlaneClient } from './control-plane-client.js';
import { type Enrolment, readEnrolment, saveEnrolment } from './control-plane-state.js';
import { installationKey } from './installation-key.js';

/** `abcd efgh jklm np23` or `ABCDEFGHJKLMNP23` → `ABCD-EFGH-JKLM-NP23`. */
export function normaliseEnrolmentCode(input: string): string {
  const characters = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const grouped = [0, 4, 8, 12].map((start) => characters.slice(start, start + 4)).join('-');
  if (characters.length !== 16 || !EnrolmentCode.safeParse(grouped).success) {
    throw new Error(
      'That is not an enrolment code: it has 16 letters and digits, like ABCD-EFGH-JKLM-NP23.',
    );
  }
  return grouped;
}

/**
 * Enrols this PC with the Vendor Control Plane using a one-time code from the vendor (ADR-0012):
 * registers the installation key and saves the installation's identity. The installer runs it
 * during activation (P0-16; ONB-003 in P7-01).
 */
export async function enrolInstallation(options: {
  readonly config: Pick<AppConfig, 'controlPlaneUrl'>;
  readonly prisma: PrismaService;
  readonly secrets: SecretStore;
  readonly code: string;
  readonly fetch?: typeof fetch;
  readonly logger?: Pick<Logger, 'log'>;
}): Promise<Enrolment> {
  const { config, prisma, secrets } = options;
  if (config.controlPlaneUrl === undefined) {
    throw new Error('Set RP_CONTROL_PLANE_URL before enrolling this PC.');
  }
  const existing = await readEnrolment(prisma);
  if (existing !== undefined) {
    throw new Error(`This PC is already enrolled as installation ${existing.installationId}.`);
  }
  const client = new ControlPlaneClient({
    baseUrl: config.controlPlaneUrl,
    key: await installationKey(secrets),
    ...(options.fetch !== undefined && { fetch: options.fetch }),
  });
  const enrolled = await client.enrol(normaliseEnrolmentCode(options.code));
  const enrolment: Enrolment = { ...enrolled, controlPlaneUrl: config.controlPlaneUrl };
  await prisma.transaction(async (tx) => {
    await saveEnrolment(tx, enrolment);
    // AUD-001; before the setup wizard there is no restaurant to audit under (the Control Plane
    // audits the enrolment on its side).
    if ((await tx.restaurant.count()) > 0) {
      await new AuditService(prisma).record(tx, {
        action: 'INSTALLATION_ENROLLED',
        entityType: 'installation',
        entityId: enrolment.installationId,
        after: {
          tenantId: enrolment.tenantId,
          channel: enrolment.channel,
          controlPlaneUrl: enrolment.controlPlaneUrl,
        },
        reason: 'Enrolled with the Vendor Control Plane',
      });
    }
  });
  options.logger?.log(
    { installationId: enrolment.installationId, channel: enrolment.channel },
    'Enrolled with the Vendor Control Plane',
  );
  return enrolment;
}
