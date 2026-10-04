import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  defaultInstallationFile,
  readInstallationFile,
  SERVICE_NAMES,
} from '../installation/installation.js';
import { probeHealth } from './health-probe.js';
import { hostStatePath, readHostState } from './host-state.js';
import { maintenancePath, readMaintenance } from './maintenance.js';
import { jsonLog } from './service-host.js';
import { Watchdog } from './watchdog.js';
import { WindowsServiceControl } from './windows-services.js';

/**
 * The watchdog's Windows service runs this (P0-16b):
 *
 *   node dist/service/watchdog-main.js [--installation <installation.json>]
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { installation: { type: 'string' } },
    allowPositionals: false,
  });
  if (process.platform !== 'win32') throw new Error('The watchdog runs on Windows only');
  const log = jsonLog('watchdog');
  const installation = await readInstallationFile(values.installation ?? defaultInstallationFile());
  const watchdog = new Watchdog({
    control: new WindowsServiceControl(),
    services: { database: SERVICE_NAMES.database, server: SERVICE_NAMES.server },
    readHost: () => readHostState(hostStatePath(installation.dataDir)),
    probe: () =>
      probeHealth({
        port: installation.server.port,
        caFile: join(installation.dataDir, 'tls', 'ca.crt'),
      }),
    maintenance: async () =>
      (await readMaintenance(maintenancePath(installation.dataDir), new Date())) !== null,
    log,
  });
  const stop = () => {
    void watchdog.stop().finally(() => process.exit(0));
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(signal, stop);
  log('info', 'Watchdog started', { pid: process.pid });
  watchdog.start();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `The watchdog failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
