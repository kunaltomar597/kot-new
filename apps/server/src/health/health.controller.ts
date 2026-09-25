import { readFileSync } from 'node:fs';
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { HealthResponse, VersionResponse } from '@rp/contracts';
import type { Response } from 'express';
import { Public } from '../auth/decorators.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';

function readPackageVersion(): { name: string; version: string } {
  const fallback = { name: '@rp/server', version: '0.0.0' };
  try {
    // Resolves to apps/server/package.json from both src/health and dist/health. A missing or
    // unreadable file (for example a different installer layout) must never stop the server.
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
    return {
      name: typeof parsed.name === 'string' ? parsed.name : fallback.name,
      version: typeof parsed.version === 'string' ? parsed.version : fallback.version,
    };
  } catch {
    return fallback;
  }
}

const PACKAGE = readPackageVersion();

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
