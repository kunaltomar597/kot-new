import type { AppBuildView } from '@rp/contracts';
import {
  type ApkInstaller,
  type ApkInstallResult,
  ApkUpdater,
  type DownloadedApk,
} from '@rp/mobile-core';
import { fakeLocalServer } from '@rp/mobile-core/testing';
import { act, fireEvent, screen } from '@testing-library/react-native';
import { AppState, Text } from 'react-native';
import {
  LoginScreen,
  megabytesOf,
  ShellProvider,
  UpdateRequiredScreen,
  useAppUpdateWhenFree,
} from '../src/index.js';
import { ADDRESS, newSession, renderShell, translator } from './harness.js';

const BUILD: AppBuildView = {
  kind: 'waiter-app',
  version: '1.5.0',
  clientApi: '1.0',
  sha256: 'c'.repeat(64),
  sizeBytes: 61_400_000,
};

/** Android's PackageInstaller as the updater sees it. */
class FakeInstaller implements ApkInstaller {
  readonly enabled = true;
  readonly installedVersion = '1.4.0';
  readonly calls: string[] = [];
  allowed = true;
  owner = false;
  private listener: ((result: ApkInstallResult) => void) | undefined;

  silent(): boolean {
    return this.owner;
  }
  mayRequestInstall(): Promise<boolean> {
    return Promise.resolve(this.allowed);
  }
  openInstallSettings(): Promise<void> {
    this.calls.push('settings');
    return Promise.resolve();
  }
  download(): Promise<DownloadedApk> {
    this.calls.push('download');
    return Promise.resolve({ path: '/cache/rp-apk/c.apk' });
  }
  install(): Promise<void> {
    this.calls.push('install');
    return Promise.resolve();
  }
  onResult(listener: (result: ApkInstallResult) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  answer(result: ApkInstallResult): void {
    this.listener?.(result);
  }
}

/** A paired device whose PC has a newer build of its app. */
async function pairedWithBuild(options: { tablet?: boolean; tooOld?: boolean } = {}) {
  const server = fakeLocalServer(
    options.tablet === true ? { type: 'TABLE_TABLET', name: 'Table 4 tablet' } : undefined,
  )
    .on('GET', '/api/v1/devices/current/app-build', () => ({
      status: 200,
      body: { build: BUILD },
    }))
    .on('GET', '/api/v1/version', () => ({
      status: 200,
      body: {
        name: 'rp-server',
        version: '2.3.0',
        apiVersion: 'v1',
        node: '24.12.0',
        clientApi: { current: '1.0', oldest: '1.0' },
      },
    }));
  if (options.tooOld === true) {
    server.on('GET', '/api/v1/auth/staff-tiles', () => ({
      status: 426,
      body: { code: 'CLIENT_TOO_OLD', message: 'Update the app.' },
    }));
  }
  const { session } = newSession(server);
  await session.start();
  await session.pair(ADDRESS, 'ABCD-EFGH');
  if (options.tooOld === true) await session.staffTiles().catch(() => undefined);
  const installer = new FakeInstaller();
  const updater = new ApkUpdater({ session, installer });
  await updater.check();
  return { session, installer, updater };
}

describe('[WTR-001] a new version of the app from the restaurant PC (P7-04e2)', () => {
  it('is offered on the sign-in screen, and installed when a person asks', async () => {
    const { session, installer, updater } = await pairedWithBuild();
    // Started, it hears Android's answers.
    updater.start();
    await renderShell(session, <LoginScreen />, undefined, updater);
    expect(screen.getByTestId('apk-offer-text')).toHaveTextContent(
      translator('mobile.apk.available', { version: '1.5.0', megabytes: 61 }),
    );
    await fireEvent.press(screen.getByTestId('apk-install'));
    expect(installer.calls).toEqual(['download', 'install']);
    expect(screen.getByTestId('apk-offer-text')).toHaveTextContent(
      translator('mobile.apk.installing'),
    );
    // The person said no on Android's screen: offered again.
    await act(() => {
      installer.answer({ kind: 'cancelled' });
    });
    expect(screen.getByTestId('apk-offer-text')).toHaveTextContent(
      translator('mobile.apk.failed.cancelled'),
    );
    expect(screen.getByTestId('apk-install')).toHaveTextContent(translator('mobile.apk.tryAgain'));
    updater.stop();
  });

  it('sends the person to Android’s setting when the app may not install yet', async () => {
    const { session, installer, updater } = await pairedWithBuild();
    installer.allowed = false;
    await renderShell(session, <LoginScreen />, undefined, updater);
    await fireEvent.press(screen.getByTestId('apk-install'));
    expect(screen.getByTestId('apk-offer-text')).toHaveTextContent(
      translator('mobile.apk.needsPermission'),
    );
    await fireEvent.press(screen.getByTestId('apk-settings'));
    expect(installer.calls).toEqual(['settings']);
    installer.allowed = true;
    await fireEvent.press(screen.getByTestId('apk-install'));
    expect(installer.calls).toEqual(['settings', 'download', 'install']);
  });

  it('[UPD-006] lets staff install it from “Update this app”, but not a tablet’s guests', async () => {
    const phone = await pairedWithBuild({ tooOld: true });
    const view = await renderShell(
      phone.session,
      <UpdateRequiredScreen />,
      undefined,
      phone.updater,
    );
    expect(screen.getByTestId('update-required')).toHaveTextContent(
      translator('mobile.update.fromPc'),
    );
    expect(screen.getByTestId('apk-install')).toBeOnTheScreen();
    await view.unmount();

    const tablet = await pairedWithBuild({ tablet: true, tooOld: true });
    await renderShell(tablet.session, <UpdateRequiredScreen />, undefined, tablet.updater);
    expect(screen.getByTestId('update-required')).toHaveTextContent(
      translator('mobile.update.guests'),
    );
    expect(screen.queryByTestId('apk-offer')).toBeNull();
  });

  it('[TAB-001] lets a kiosk tablet install by itself once it is free', async () => {
    const { session, installer, updater } = await pairedWithBuild({ tablet: true });
    installer.owner = true;
    function Probe({ inUse }: { inUse: boolean }) {
      useAppUpdateWhenFree(inUse);
      return <Text>{inUse ? 'guests' : 'free'}</Text>;
    }
    Object.assign(AppState, { currentState: 'active' });
    const view = await renderShell(session, <Probe inUse />, undefined, updater);
    expect(installer.calls).toEqual([]);
    // `rerender` replaces the whole tree: the provider comes again.
    await view.rerender(
      <ShellProvider session={session} translator={translator} apkUpdater={updater}>
        <Probe inUse={false} />
      </ShellProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(installer.calls).toEqual(['download', 'install']);
    Object.assign(AppState, { currentState: undefined });
  });

  it('shows nothing while the app is up to date, and sizes in whole megabytes', async () => {
    const { session } = newSession();
    await session.start();
    await session.pair(ADDRESS, 'ABCD-EFGH');
    const updater = new ApkUpdater({ session, installer: new FakeInstaller() });
    await renderShell(session, <LoginScreen />, undefined, updater);
    expect(screen.queryByTestId('apk-offer')).toBeNull();
    expect(megabytesOf(61_400_000)).toBe(61);
    expect(megabytesOf(12_000)).toBe(1);
  });
});
