import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const manifestText = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'android',
    'src',
    'main',
    'AndroidManifest.xml',
  ),
  'utf8',
);

/** The manifest without its comments, removed until none is left (a nested "<!--" too). */
function withoutComments(xml: string): string {
  let text = xml;
  for (;;) {
    const start = text.indexOf('<!--');
    if (start < 0) return text;
    const end = text.indexOf('-->', start + 4);
    text = end < 0 ? text.slice(0, start) : text.slice(0, start) + text.slice(end + 3);
  }
}
const manifest = withoutComments(manifestText);

/** Every component element with its attributes. */
function components() {
  const found: { kind: string; name: string; attributes: Record<string, string> }[] = [];
  for (const match of manifest.matchAll(/<(service|receiver|activity|provider)\b([^>]*?)\/?>/g)) {
    const attributes: Record<string, string> = {};
    for (const attribute of (match[2] ?? '').matchAll(/android:(\w+)="([^"]*)"/g)) {
      attributes[attribute[1] ?? ''] = attribute[2] ?? '';
    }
    found.push({ kind: match[1] ?? '', name: attributes.name ?? '', attributes });
  }
  return found;
}

describe('[SEC-010] [MOBILE-T3] what the apps’ manifest exports', () => {
  it('declares every component with an explicit exported flag', () => {
    const all = components();
    expect(all.map((component) => component.name)).toEqual([
      'com.rp.mobilenative.RpAlertService',
      'com.rp.mobilenative.RpAlertActionReceiver',
      'com.rp.mobilenative.RpApkInstallReceiver',
      'com.rp.mobilenative.RpPackageReplacedReceiver',
      'com.rp.mobilenative.RpDeviceAdminReceiver',
    ]);
    for (const component of all) expect(component.attributes.exported).toMatch(/^(true|false)$/);
  });

  it('exports only the device admin receiver, and only to the system', () => {
    const exported = components().filter((component) => component.attributes.exported === 'true');
    expect(exported.map((component) => component.name)).toEqual([
      'com.rp.mobilenative.RpDeviceAdminReceiver',
    ]);
    expect(exported[0]?.attributes.permission).toBe('android.permission.BIND_DEVICE_ADMIN');
  });

  it('asks for no permission the apps do not use', () => {
    const permissions = [...manifest.matchAll(/<uses-permission android:name="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(permissions.sort()).toEqual(
      [
        'android.permission.ACCESS_NETWORK_STATE',
        'android.permission.FOREGROUND_SERVICE',
        'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
        'android.permission.POST_NOTIFICATIONS',
        'android.permission.REQUEST_INSTALL_PACKAGES',
        'android.permission.VIBRATE',
        'android.permission.WAKE_LOCK',
      ].sort(),
    );
  });
});
