import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { PushedSettings } from '@rp/contracts/control-plane';
import { saveVendorSettingsDigest } from '../cloud/control-plane-state.js';
import { HeartbeatService } from '../cloud/heartbeat.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';

/**
 * Applies the vendor settings and feature flags a heartbeat answer pushes (UPD-010, P7-08c), then
 * remembers their digest, which the next heartbeat reports so the vendor stops sending them.
 */
@Injectable()
export class VendorSettingsAgent implements OnModuleInit {
  private readonly logger = new Logger(VendorSettingsAgent.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly heartbeat: HeartbeatService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    this.heartbeat.onAnswer(async (answer) => {
      if (answer.vendorSettings !== null) await this.apply(answer.vendorSettings);
    });
  }

  async apply(pushed: PushedSettings): Promise<string[]> {
    const changed = await this.settings.applyVendorSettings(pushed.values);
    await saveVendorSettingsDigest(this.prisma, pushed.digest);
    if (changed.length > 0) {
      this.logger.log({ keys: changed }, 'Applied settings from the vendor');
    }
    return changed;
  }
}
