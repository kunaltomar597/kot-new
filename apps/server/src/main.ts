import 'reflect-metadata';
import { createApp } from './app.factory.js';
import { loadConfig } from './config/app-config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port, config.host);
}

main().catch((error: unknown) => {
  // The logger may not exist yet (for example, invalid configuration), so write directly.
  process.stderr.write(
    `Local server failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
