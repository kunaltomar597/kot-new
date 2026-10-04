/**
 * The programs the installer bundles besides our own (P0-16d), each pinned by version and SHA-256,
 * so a download that changed fails the build instead of reaching a restaurant (SEC-013). To update
 * one, change its version, address and hash together; the stage step prints the hash of a
 * download that does not match. The Node.js major follows `.nvmrc`; PostgreSQL stays on 16, the
 * version the server is tested against.
 */
export interface Component {
  readonly id: 'node' | 'postgres' | 'winsw' | 'winsw-licence';
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  /** SPDX identifier, for the licence policy (infra/ci/license-policy.json). */
  readonly licence: string;
}

/** Node.js for Windows x64: runs the server, the service host and the watchdog. */
export const NODE: Component = {
  id: 'node',
  version: '24.21.0',
  url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip',
  // As in https://nodejs.org/dist/v24.21.0/SHASUMS256.txt.
  sha256: '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
  licence: 'MIT',
};

/** PostgreSQL 16 for Windows x64 (EDB's binaries): the `RPDatabase` service. */
export const POSTGRES: Component = {
  id: 'postgres',
  version: '16.15',
  url: 'https://get.enterprisedb.com/postgresql/postgresql-16.15-1-windows-x64-binaries.zip',
  // EDB publishes no checksum; this is the file as first downloaded over HTTPS on 2026-10-05.
  sha256: '25e6fcdfb8caec38691bf461125e7564508760666f7b8e5dc6a5f0818f58f81e',
  licence: 'PostgreSQL',
};

/**
 * WinSW 2 for .NET Framework 4.6.1, which runs on the .NET Framework 4.8 that Windows 10 and 11
 * have and update themselves; the self-contained build carries its own, unsupported .NET Core 3.1.
 * Copied as `RPServer.exe` and `RPWatchdog.exe` beside their XML definitions (P0-16b).
 */
export const WINSW: Component = {
  id: 'winsw',
  version: '2.12.0',
  url: 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe',
  sha256: 'b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f',
  licence: 'MIT',
};

/** WinSW's licence, shipped beside it as MIT asks. */
export const WINSW_LICENCE: Component = {
  id: 'winsw-licence',
  version: '2.12.0',
  url: 'https://raw.githubusercontent.com/winsw/winsw/v2.12.0/LICENSE.txt',
  sha256: '1cdf703c10a70e5973bf3acf2a5eeabe7746237155b92db2034aeae26fdf7802',
  licence: 'MIT',
};

export const COMPONENTS: readonly Component[] = [NODE, POSTGRES, WINSW, WINSW_LICENCE];
