import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { HealthResponse, VersionResponse } from '@rp/contracts';
import type { Response } from 'express';
import { Public } from '../auth/decorators.js';
import { SERVER_PACKAGE } from '../common/package-version.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';

const PACKAGE = SERVER_PACKAGE;

/**
 * Liveness, readiness and version endpoints. Public: the watchdog and devices call them before
 * anyone signs in, and they reveal no business data.
 */
@Public()
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 200 when everything is up, 503 when the database is down (the watchdog restarts on 503). */
  @Get('health')
  async health(@Res({ passthrough: true }) response: Response): Promise<HealthResponse> {
    const database = await this.prisma.ping();
    if (!database.up) response.status(503);
    return {
      status: database.up ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      checks: {
        database: { status: database.up ? 'up' : 'down', latencyMs: database.latencyMs },
      },
    };
  }

  @Get('version')
  version(): VersionResponse {
    return {
      name: PACKAGE.name,
      version: PACKAGE.version,
      apiVersion: 'v1',
      node: process.version,
      ...(this.config.buildId !== undefined && { buildId: this.config.buildId }),
    };
  }
}
