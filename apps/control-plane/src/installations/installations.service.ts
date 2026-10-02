import { Injectable } from '@nestjs/common';
import {
  CONTROL_PLANE_ERRORS,
  type EnrolRequest,
  type EnrolResponse,
  enrolmentProofMessage,
} from '@rp/contracts/control-plane';
import { AuditService } from '../audit/audit.service.js';
import { ed25519PublicKey, spkiBase64, verifyEd25519 } from '../auth/ed25519.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { PrismaService } from '../database/prisma.service.js';
import { CpError } from '../errors/cp-error.js';
import { Prisma } from '../generated/prisma/client.js';
import { hashEnrolmentCode } from './enrolment-code.js';

/** Enrolment attempts allowed per client address and minute. */
const ENROL_ATTEMPTS_PER_MINUTE = 10;

function enrolmentInvalid(): CpError {
  return new CpError(
    401,
    CONTROL_PLANE_ERRORS.enrolmentInvalid,
    'This enrolment code is not valid. Check it, or ask the vendor for a new one.',
  );
}

/** Enrolment of restaurant PCs with one-time codes (ADR-0012, SEC-002). */
@Injectable()
export class InstallationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiter,
  ) {}

  /**
   * Registers the installation's public key if the code is valid and the proof shows the caller
   * holds the matching private key. The code is used up in the same transaction.
   */
  async enrol(request: EnrolRequest, clientAddress: string): Promise<EnrolResponse> {
    if (!this.limiter.hit(`enrol:${clientAddress}`, ENROL_ATTEMPTS_PER_MINUTE, 60_000)) {
      throw new CpError(
        429,
        CONTROL_PLANE_ERRORS.tooManyAttempts,
        'Too many enrolment attempts. Wait a minute and try again.',
      );
    }
    const key = ed25519PublicKey(request.publicKey);
    if (
      key === undefined ||
      !verifyEd25519(key, enrolmentProofMessage(request.code), request.proof)
    ) {
      throw enrolmentInvalid();
    }
    const codeHash = hashEnrolmentCode(request.code);
    const now = new Date();
    return this.prisma.transaction(async (tx) => {
      const installation = await tx.installation.findUnique({
        where: { enrolmentCodeHash: codeHash },
      });
      const expiresAt = installation?.enrolmentCodeExpiresAt ?? null;
      // A PENDING installation activates; an ACTIVE one with a code is moving to a new PC.
      const moving = installation?.status === 'ACTIVE';
      if (
        installation === null ||
        (installation.status !== 'PENDING' && !moving) ||
        expiresAt === null ||
        expiresAt <= now
      ) {
        throw enrolmentInvalid();
      }
      // Conditional on the code still being there: two PCs racing with one code cannot both win.
      const { count } = await tx.installation.updateMany({
        where: { id: installation.id, enrolmentCodeHash: codeHash, status: installation.status },
        data: {
          status: 'ACTIVE',
          publicKey: spkiBase64(key),
          enrolledAt: now,
          enrolmentCodeHash: null,
          enrolmentCodeExpiresAt: null,
        },
      });
      if (count !== 1) throw enrolmentInvalid();
      if (moving) {
        // The licence binds the new PC at its first heartbeat (LIC-004).
        await tx.installationLicence.updateMany({
          where: { installationId: installation.id },
          data: { fingerprint: Prisma.DbNull, boundAt: null, revision: { increment: 1 } },
        });
      }
      await this.audit.record(tx, {
        actor: `installation:${installation.id}`,
        action: moving ? 'installation.moved' : 'installation.enrolled',
        targetType: 'installation',
        targetId: installation.id,
        details: { clientAddress },
      });
      return {
        installationId: installation.id,
        tenantId: installation.tenantId,
        name: installation.name,
        channel: installation.channel,
        enrolledAt: now.toISOString(),
      };
    });
  }
}
