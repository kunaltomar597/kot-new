import 'reflect-metadata';
import { createControlPlaneApp } from './app.factory.js';
import { loadConfig } from './config/cp-config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createControlPlaneApp(config);
  await app.listen(config.port, config.host);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Control Plane failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
