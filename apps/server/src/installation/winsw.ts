import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type InstallationFile, installationPaths, SERVICE_NAMES } from './installation.js';

/**
 * The WinSW 2 definitions of the server's and the watchdog's Windows services (ONB-001, NFR-A04,
 * P0-16b). Each is `<installDir>\services\<name>.xml` beside WinSW's `<name>.exe`, which P0-16d
 * ships. Both start at boot before anyone signs in, and Windows restarts them when they fail.
 *
 * The accounts are set by the set-up script after `install` (P0-16c), with
 * `sc.exe config RPServer obj= "NT SERVICE\RPServer"` (a virtual account that owns the data folder)
 * and the watchdog as LocalSystem, which may start and stop the other services.
 */

export function xmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** A command-line argument in double quotes (Windows' rules: no quote inside). */
function argument(value: string): string {
  if (value.includes('"')) throw new Error(`A path with a double quote cannot be used: ${value}`);
  return `"${value}"`;
}

interface ServiceDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly script: string;
  readonly depend?: string;
}

function definition(
  installation: InstallationFile,
  installationFile: string,
  service: ServiceDefinition,
): string {
  const paths = installationPaths(installation);
  const args = [argument(service.script), '--installation', argument(installationFile)].join(' ');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- Written by the Restaurant Platform installer; repair writes it again. -->',
    '<service>',
    `  <id>${xmlText(service.id)}</id>`,
    `  <name>${xmlText(service.name)}</name>`,
    `  <description>${xmlText(service.description)}</description>`,
    `  <executable>${xmlText(paths.node)}</executable>`,
    `  <arguments>${xmlText(args)}</arguments>`,
    `  <workingdirectory>${xmlText(paths.serverDir)}</workingdirectory>`,
    '  <startmode>Automatic</startmode>',
    ...(service.depend === undefined ? [] : [`  <depend>${xmlText(service.depend)}</depend>`]),
    '  <onfailure action="restart" delay="1 sec"/>',
    '  <onfailure action="restart" delay="2 sec"/>',
    '  <onfailure action="restart" delay="5 sec"/>',
    '  <resetfailure>1 hour</resetfailure>',
    '  <stopparentprocessfirst>true</stopparentprocessfirst>',
    '  <stoptimeout>15 sec</stoptimeout>',
    `  <logpath>${xmlText(paths.logsDir)}</logpath>`,
    '  <log mode="roll-by-size">',
    '    <sizeThreshold>10240</sizeThreshold>',
    '    <keepFiles>8</keepFiles>',
    '  </log>',
    '</service>',
    '',
  ];
  return lines.join('\r\n');
}

/** The server's service: the service host, after the database's service. */
export function serverServiceXml(installation: InstallationFile, installationFile: string): string {
  const { serverDir } = installationPaths(installation);
  return definition(installation, installationFile, {
    id: SERVICE_NAMES.server,
    name: 'Restaurant Platform server',
    description:
      'The restaurant server for the POS, kitchen screens, waiter phones, table tablets and pagers.',
    script: join(serverDir, 'dist', 'service', 'service-host-main.js'),
    depend: SERVICE_NAMES.database,
  });
}

/** The watchdog's service. */
export function watchdogServiceXml(
  installation: InstallationFile,
  installationFile: string,
): string {
  const { serverDir } = installationPaths(installation);
  return definition(installation, installationFile, {
    id: SERVICE_NAMES.watchdog,
    name: 'Restaurant Platform watchdog',
    description: 'Keeps the Restaurant Platform database and server services running.',
    script: join(serverDir, 'dist', 'service', 'watchdog-main.js'),
  });
}

/** Writes both definitions; returns their paths. */
export async function writeServiceDefinitions(
  installation: InstallationFile,
  installationFile: string,
): Promise<string[]> {
  const { servicesDir } = installationPaths(installation);
  await mkdir(servicesDir, { recursive: true });
  const files = [
    [
      join(servicesDir, `${SERVICE_NAMES.server}.xml`),
      serverServiceXml(installation, installationFile),
    ],
    [
      join(servicesDir, `${SERVICE_NAMES.watchdog}.xml`),
      watchdogServiceXml(installation, installationFile),
    ],
  ] as const;
  for (const [path, xml] of files) await writeFile(path, xml);
  return files.map(([path]) => path);
}
