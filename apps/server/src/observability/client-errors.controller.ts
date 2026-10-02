import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ClientErrorReport } from '@rp/contracts';
import type { SentryReporter } from '@rp/error-reporting';
import { authErrors } from '../auth/auth-errors.js';
import { RequireDevice } from '../auth/decorators.js';
import { type AuthenticatedRequest, deviceOf } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { SENTRY_REPORTER } from './tokens.js';

/** Reports from one device in an hour, at most; the rest are dropped quietly. */
const PER_DEVICE_HOURLY = 20;

/** An error an app reported, rebuilt for the error service with the app's own stack. */
class ClientError extends Error {
  constructor(message: string, stack: string | null) {
    super(message);
    this.name = 'ClientError';
    this.stack = stack ?? `ClientError: ${message}`;
  }
}

/**
 * Apps' errors (NFR-O02, P7-08d): a paired device posts them here and the server reports them
 * with its own key, scrubbed (no app carries the key, SEC-002).
 */
@Controller('client-errors')
export class ClientErrorsController {
  private readonly recent = new Map<string, number[]>();

  constructor(@Inject(SENTRY_REPORTER) private readonly sentry: SentryReporter | null) {}

  @Post()
  @HttpCode(204)
  @RequireDevice()
  report(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(ClientErrorReport)) body: ClientErrorReport,
  ): void {
    const device = deviceOf(request);
    if (device === undefined) throw authErrors.unauthenticated();
    if (this.sentry === null || !this.allow(device.deviceId)) return;
    this.sentry.report(
      new ClientError(body.message, body.stack),
      { path: body.path, appVersion: body.appVersion },
      { component: body.component, deviceType: device.type },
    );
  }

  private allow(deviceId: string, now = Date.now()): boolean {
    const times = (this.recent.get(deviceId) ?? []).filter((time) => now - time < 3_600_000);
    if (times.length >= PER_DEVICE_HOURLY) return false;
    times.push(now);
    this.recent.set(deviceId, times);
    return true;
  }
}
