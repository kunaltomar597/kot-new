import 'reflect-metadata';
import { createApp } from './app.factory.js';
import type { SentryReporter } from '@rp/error-reporting';
import { createSecretStore } from './auth/secret-store.js';
import { runPendingRestore } from './backups/pending-restore.js';
import { RESTART_EXIT_CODE, ServerLifecycle, SHUTDOWN_MESSAGE } from './common/server-lifecycle.js';
import { loadConfig } from './config/app-config.js';
import { SENTRY_REPORTER } from './observability/error-reporter.js';

/** The app once it exists, so a stop asked for during start-up can still close it. */
let started: { close(): Promise<void> } | undefined;

if (process.send !== undefined) {
  // Run by the service host (P0-16b): it says when to stop, over IPC, since Windows has no
  // signals. The channel closing means the host is gone, so the server goes too and never holds
  // the ports against the next host. Ctrl+C reaches the whole console on Windows; the host passes
  // the stop on itself. Listening from the first moment, so a stop during start-up is not missed.
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void (started?.close() ?? Promise.resolve()).finally(() => process.exit(0));
  };
  process.on('message', (message: unknown) => {
    if ((message as { type?: unknown } | null)?.type === SHUTDOWN_MESSAGE.type) close();
  });
  process.on('disconnect', close);
  process.on('SIGINT', () => undefined);
}

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
  started = app;
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
