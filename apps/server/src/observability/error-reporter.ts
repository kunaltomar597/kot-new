import { Global, Injectable, Module } from '@nestjs/common';
import { SentryReporter } from '@rp/error-reporting';
import { SERVER_PACKAGE } from '../common/package-version.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { ClientErrorsController } from './client-errors.controller.js';
import { ERROR_REPORTER, SENTRY_REPORTER } from './tokens.js';

/**
 * Crash and error reporting to the vendor's error-monitoring service (NFR-O02, P7-08d), through
 * `@rp/error-reporting`: scrubbed of secrets and personal data, rate-limited, never blocking.
 */
export interface ErrorReporter {
  report(error: unknown, context: Readonly<Record<string, unknown>>): void;
}

export { ERROR_REPORTER, SENTRY_REPORTER } from './tokens.js';

@Injectable()
export class NoopErrorReporter implements ErrorReporter {
  report(): void {
    // No error service configured: the error is in the local log only.
  }
}

/**
 * Server errors reported since the process started, for the heartbeat's error count (VCP-005,
 * NFR-O03): the Control Plane learns how many happened between two heartbeats.
 */
@Injectable()
export class ErrorCounter {
  private reported = 0;

  record(): void {
    this.reported += 1;
  }

  get total(): number {
    return this.reported;
  }
}

/** Counts every report, then hands it to the reporting service. */
export function countingReporter(counter: ErrorCounter, inner: ErrorReporter): ErrorReporter {
  return {
    report(error, context) {
      counter.record();
      inner.report(error, context);
    },
  };
}

/** The reporter for this server, when the installer set the vendor's DSN. */
export function sentryReporterFor(config: AppConfig): SentryReporter | null {
  if (config.errorDsn === undefined) return null;
  return new SentryReporter({
    dsn: config.errorDsn,
    component: 'server',
    release: `restaurant-pc@${config.productVersion ?? SERVER_PACKAGE.version}`,
    environment: config.nodeEnv,
  });
}

@Global()
@Module({
  controllers: [ClientErrorsController],
  providers: [
    ErrorCounter,
    { provide: SENTRY_REPORTER, useFactory: sentryReporterFor, inject: [APP_CONFIG] },
    {
      provide: ERROR_REPORTER,
      useFactory: (counter: ErrorCounter, sentry: SentryReporter | null) =>
        countingReporter(
          counter,
          sentry === null
            ? new NoopErrorReporter()
            : {
                report: (error, context) => {
                  sentry.report(error, context);
                },
              },
        ),
      inject: [ErrorCounter, SENTRY_REPORTER],
    },
  ],
  exports: [ERROR_REPORTER, ErrorCounter, SENTRY_REPORTER],
})
export class ObservabilityModule {}
