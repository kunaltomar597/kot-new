import { Injectable } from '@nestjs/common';
import {
  type ReleaseChannel,
  type ReleaseComponent,
  ReleaseInfo,
} from '@rp/contracts/control-plane';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { CpError } from '../errors/cp-error.js';
import type { Release } from '../generated/prisma/client.js';
import { newId } from '../ids.js';
import { compareVersions, parseVersion } from './semver.js';

/** What the vendor publishes (the admin CLI or, from P7-04, the release pipeline). */
export const PublishRelease = ReleaseInfo.omit({ publishedAt: true, notes: true }).extend({
  notes: z.string().max(2_000).optional(),
});
export type PublishRelease = z.infer<typeof PublishRelease>;

function toInfo(release: Release): ReleaseInfo {
  return {
    component: release.component,
    channel: release.channel,
    version: release.version,
    url: release.url,
    sha256: release.sha256,
    sizeBytes: Number(release.sizeBytes),
    notes: release.notes,
    publishedAt: release.publishedAt.toISOString(),
  };
}

/** Release channels (UPD-002): what each installation should run. */
@Injectable()
export class ReleasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async publish(input: PublishRelease, actor: string): Promise<ReleaseInfo> {
    const release = PublishRelease.parse(input);
    const existing = await this.prisma.release.findUnique({
      where: {
        component_channel_version: {
          component: release.component,
          channel: release.channel,
          version: release.version,
        },
      },
    });
    if (existing !== null) {
      throw new CpError(
        409,
        'RELEASE_EXISTS',
        `${release.component} ${release.version} is already on the ${release.channel} channel.`,
      );
    }
    return this.prisma.transaction(async (tx) => {
      const created = await tx.release.create({
        data: {
          id: newId(),
          component: release.component,
          channel: release.channel,
          version: release.version,
          url: release.url,
          sha256: release.sha256,
          sizeBytes: BigInt(release.sizeBytes),
          notes: release.notes ?? null,
          publishedBy: actor,
        },
      });
      await this.audit.record(tx, {
        actor,
        action: 'release.published',
        targetType: 'release',
        targetId: created.id,
        details: {
          component: created.component,
          channel: created.channel,
          version: created.version,
          sha256: created.sha256,
        },
      });
      return toInfo(created);
    });
  }

  /** The newest release of `component` on `channel`, or null when there is none. */
  async latest(component: ReleaseComponent, channel: ReleaseChannel): Promise<ReleaseInfo | null> {
    const releases = await this.prisma.release.findMany({ where: { component, channel } });
    let newest:
      { release: Release; version: NonNullable<ReturnType<typeof parseVersion>> } | undefined;
    for (const release of releases) {
      const version = parseVersion(release.version);
      if (version === undefined) continue;
      if (newest === undefined || compareVersions(version, newest.version) > 0) {
        newest = { release, version };
      }
    }
    return newest === undefined ? null : toInfo(newest.release);
  }

  /**
   * The release an installation on `channel` running `currentVersion` should move to: the newest
   * on the channel when it is newer, else null (also when the running version is not semantic).
   */
  async updateFor(
    component: ReleaseComponent,
    channel: ReleaseChannel,
    currentVersion: string,
  ): Promise<ReleaseInfo | null> {
    const current = parseVersion(currentVersion);
    if (current === undefined) return null;
    const newest = await this.latest(component, channel);
    if (newest === null) return null;
    const offered = parseVersion(newest.version);
    return offered !== undefined && compareVersions(offered, current) > 0 ? newest : null;
  }
}
