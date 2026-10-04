import { readFileSync } from 'node:fs';
import { app, BrowserWindow, session } from 'electron';
import { createTranslator } from '@rp/i18n';
import { installationFileOf, installationSettings, shellConfig } from './config.js';
import { startShell } from './shell.js';

// The shell's entry point (P0-16a): Electron's own objects, wired to `startShell`.
const t = createTranslator();

/** The installation file, when this PC has one (P0-16d). */
function readInstallationFile(): string | undefined {
  try {
    return readFileSync(installationFileOf(process.env), 'utf8');
  } catch {
    return undefined;
  }
}

const config = shellConfig(process.env, installationSettings(readInstallationFile()));

void startShell({
  app,
  session: () => session.defaultSession,
  createWindow: (options) => new BrowserWindow(options),
  config,
  // Chromium's network stack, so the shell's certificate rule applies to the health check too.
  fetch: (input, init) =>
    session.defaultSession.fetch(input instanceof URL ? input.href : input, init),
  readCa: () => {
    if (config.caFile === undefined) return undefined;
    try {
      return readFileSync(config.caFile, 'utf8');
    } catch {
      // The server writes it at its first start.
      return undefined;
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  text: { title: t('desktop.title'), starting: t('desktop.starting') },
  log: (message) => process.stdout.write(`${message}\n`),
});
