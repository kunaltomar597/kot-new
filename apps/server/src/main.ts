import 'reflect-metadata';
import { createApp } from './app.factory.js';
import type { SentryReporter } from '@rp/error-reporting';
import { loadConfig } from './config/app-config.js';
import { SENTRY_REPORTER } from './observability/error-reporter.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  // NFR-O02: a crash is reported (scrubbed) before the process exits; the watchdog restarts it.
  const sentry = app.get<SentryReporter | null>(SENTRY_REPORTER);
  if (sentry !== null) {
    process.on('uncaughtException', (error) => {
      sentry.report(error, { fatal: true });
      void Promise.race([
        sentry.flush(),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]).finally(() => {
        process.stderr.write(`Uncaught exception: ${error.stack ?? error.message}\n`);
        process.exit(1);
      });
    });
  }
  await app.listen(config.port, config.host);
}

main().catch((error: unknown) => {
  // The logger may not exist yet (for example, invalid configuration), so write directly.
  process.stderr.write(
    `Local server failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
