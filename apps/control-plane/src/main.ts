import 'reflect-metadata';
import { createControlPlaneApp } from './app.factory.js';
import type { SentryReporter } from '@rp/error-reporting';
import { loadConfig } from './config/cp-config.js';
import { CP_ERROR_REPORTER } from './errors/error-reporting.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createControlPlaneApp(config);
  // NFR-O02: a crash is reported (scrubbed) before the process exits and is restarted.
  const reporter = app.get<SentryReporter | null>(CP_ERROR_REPORTER);
  if (reporter !== null) {
    process.on('uncaughtException', (error) => {
      reporter.report(error, { fatal: true });
      void Promise.race([
        reporter.flush(),
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
  process.stderr.write(
    `Control Plane failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
