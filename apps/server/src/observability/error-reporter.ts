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

@Global()
@Module({
  providers: [
    ErrorCounter,
    {
      provide: ERROR_REPORTER,
      useFactory: (counter: ErrorCounter) => countingReporter(counter, new NoopErrorReporter()),
      inject: [ErrorCounter],
    },
  ],
  exports: [ERROR_REPORTER, ErrorCounter],
})
export class ObservabilityModule {}
