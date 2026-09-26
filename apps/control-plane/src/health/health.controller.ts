import { Controller, Get, Res } from '@nestjs/common';
import type { HealthResponse } from '@rp/contracts/control-plane';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator.js';
import { PrismaService } from '../database/prisma.service.js';

const STARTED_AT = Date.now();

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  // Public: the load balancer and uptime monitoring call it; it reveals only whether the service
  // and its database answer.
  @Get()
  @Public()
  async health(@Res({ passthrough: true }) response: Response): Promise<HealthResponse> {
    const database = await this.prisma.ping();
    response.status(database.up ? 200 : 503);
    return {
      status: database.up ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      checks: { database: { status: database.up ? 'up' : 'down', latencyMs: database.latencyMs } },
    };
  }
}
