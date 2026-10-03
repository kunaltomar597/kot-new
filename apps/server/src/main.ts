import 'reflect-metadata';
import { createApp } from './app.factory.js';
import type { SentryReporter } from '@rp/error-reporting';
import { createSecretStore } from './auth/secret-store.js';
import { runPendingRestore } from './backups/pending-restore.js';
import { RESTART_EXIT_CODE, ServerLifecycle } from './common/server-lifecycle.js';
import { loadConfig } from './config/app-config.js';
import { SENTRY_REPORTER } from './observability/error-reporter.js';

async function main(): Promise<void> {
  const config = loadConfig();
  // DATA-004: a restore asked for on the System page runs before anything uses the database
  // (when the Windows service has not run the restore tool already, P0-16).
  if (config.adminDatabaseUrl !== undefined) {
    await runPendingRestore({
      dataDir: config.dataDir,
      databaseUrl: config.databaseUrl,
      adminUrl: config.adminDatabaseUrl,
      pgBin: config.pgBin,
      secrets: createSecretStore(config),
      log: (message) => process.stdout.write(`${message}\n`),
    });
  }
  const app = await createApp(config);
  // A restart that is meant (a restore): the service starts the server again on this exit code.
  app.get(ServerLifecycle).onRestart(() => {
    void app.close().finally(() => process.exit(RESTART_EXIT_CODE));
  });
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
