import { Global, Injectable, Module } from '@nestjs/common';

/**
 * Crash and error reporting to the vendor's error-monitoring service (NFR-O02).
 * Implementations must scrub personal data and secrets before sending. The Sentry (or
 * equivalent) implementation is wired in P7-08 once the account exists.
 */
export interface ErrorReporter {
  report(error: unknown, context: Readonly<Record<string, unknown>>): void;
}

export const ERROR_REPORTER = Symbol('ERROR_REPORTER');

@Injectable()
export class NoopErrorReporter implements ErrorReporter {
  report(): void {
    // Intentionally empty until an error-monitoring service is configured.
  }
}

@Global()
@Module({
  providers: [{ provide: ERROR_REPORTER, useClass: NoopErrorReporter }],
  exports: [ERROR_REPORTER],
})
export class ObservabilityModule {}
