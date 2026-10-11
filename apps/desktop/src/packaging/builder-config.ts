import { join } from 'node:path';
import type { Configuration } from 'electron-builder';
import { INSTALL_FOLDERS, type StagingLayout } from './payload.js';

/**
 * The installer for the restaurant PC (ONB-001, P0-16d): electron-builder's NSIS installer with
 * the POS window (P0-16a) and, beside it, the server, Node.js, PostgreSQL, WinSW and the set-up
 * scripts. `installer/installer.nsh` adds the data-drive page (ONB-002) and runs the set-up scripts
 * (P0-16c) on install, update, repair and uninstall.
 */

/** Never change it: the installer finds the installed version, to update it, by this id. */
export const APP_ID = 'in.restaurantplatform.pos';

/** The working name (OI-01); the install folder is `C:\Program Files\Restaurant Platform`. */
export const PRODUCT_NAME = 'Restaurant Platform';

/**
 * Electron's fuses (SEC-011), set in the packaged executable: it cannot be run as Node.js or be
 * given Node.js options or a debugger, and it loads only its own app.asar, checked against the
 * hash recorded in the executable. Cookies are encrypted with the Windows user's key.
 */
export const ELECTRON_FUSES = {
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  enableCookieEncryption: true,
  grantFileProtocolExtraPrivileges: false,
} as const;

export interface BuilderOptions {
  /** apps/desktop: `installer/` holds installer.nsh. */
  readonly projectDir: string;
  readonly staging: StagingLayout;
  readonly outputDir: string;
  /** The product's version: the installer's, and the installation file's `productVersion`. */
  readonly version: string;
  readonly electronVersion: string;
  /**
   * Sign the executables and set their version information. Signing happens only when the
   * certificate is given (`WIN_CSC_LINK`); setting the version information needs Windows (or
   * Wine), so builds on other systems leave it out.
   */
  readonly editExecutable: boolean;
}

export function builderConfig(options: BuilderOptions): Configuration {
  const { staging } = options;
  return {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    copyright: `Copyright © ${new Date().getUTCFullYear()} ${PRODUCT_NAME}`,
    electronVersion: options.electronVersion,
    extraMetadata: { version: options.version },
    directories: {
      app: staging.app,
      output: options.outputDir,
      buildResources: join(options.projectDir, 'installer'),
    },
    files: ['main.js', 'package.json'],
    asar: true,
    // The app is one bundled file. Answering false here tells electron-builder that node_modules
    // are handled elsewhere, so it neither rebuilds nor looks for any (it would otherwise take
    // apps/desktop's own into app.asar).
    beforeBuild: () => Promise.resolve(false),
    nodeGypRebuild: false,
    electronFuses: ELECTRON_FUSES,
    // The server's programs go beside the app, where installationPaths expects them. One set from
    // the payload's root: electron-builder drops a node_modules at the root of a copied set (its
    // createFilter), which per-folder sets made of the server's own (server/node_modules).
    extraFiles: [
      {
        from: staging.payload,
        to: '.',
        filter: Object.values(INSTALL_FOLDERS).map((folder) => `${folder}/**/*`),
      },
    ],
    publish: null,
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      signAndEditExecutable: options.editExecutable,
      requestedExecutionLevel: 'asInvoker',
    },
    nsis: {
      oneClick: false,
      // For every Windows user of the PC, in Program Files; the installer asks for administrator
      // rights, which the services and the firewall need.
      perMachine: true,
      allowElevation: true,
      allowToChangeInstallationDirectory: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: PRODUCT_NAME,
      runAfterFinish: true,
      // The restaurant's data is never the uninstaller's to delete unasked (NFR-I02).
      deleteAppDataOnUninstall: false,
      differentialPackage: false,
      include: join(options.projectDir, 'installer', 'installer.nsh'),
      warningsAsErrors: true,
      artifactName: 'RestaurantPlatform-Setup-${version}.${ext}',
      uninstallDisplayName: '${productName} ${version}',
    },
  };
}
