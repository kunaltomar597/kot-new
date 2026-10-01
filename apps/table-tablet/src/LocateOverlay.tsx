import type { DomainEvent } from '@rp/contracts';
import { fontSize, fontWeight } from '@rp/design-tokens';
import type { Kiosk } from '@rp/mobile-core';
import { useDeviceSession, useSessionState, useT } from '@rp/mobile-shell';
import { useTheme, weight } from '@rp/ui-native';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

/** A request older than this (e.g. replayed after a reconnect) is not shown. */
const FRESH_MS = 60_000;
const FLASH_MS = 500;
const TONE_MS = 3_000;

/** Whether `event` asks this device to show itself now (MGR-006). */
export function locateRequest(
  event: DomainEvent,
  deviceId: string | undefined,
  now: number,
): { seconds: number } | undefined {
  if (event.type !== 'DeviceLocateRequested' || event.payload.deviceId !== deviceId) return;
  if (Math.abs(now - Date.parse(event.occurredAt)) > FRESH_MS) return;
  return { seconds: event.payload.seconds };
}

/**
 * "Locate" (MGR-006, P3-01c): when a manager asks from the dashboard, the tablet flashes its name
 * in the restaurant's colour and sounds a tone, so it is found among the tables.
 */
export function LocateOverlay({ kiosk }: { kiosk: Kiosk }) {
  const session = useDeviceSession();
  const { device } = useSessionState();
  const t = useT();
  const { colors } = useTheme();
  const [until, setUntil] = useState(0);
  const [lit, setLit] = useState(true);
  const deviceId = device?.id;

  useEffect(
    () =>
      session.onEvent((event) => {
        const request = locateRequest(event, deviceId, Date.now());
        if (request === undefined) return;
        setUntil(Date.now() + request.seconds * 1_000);
        kiosk.locateTone(TONE_MS).catch(() => undefined);
      }),
    [deviceId, kiosk, session],
  );
  const showing = until > 0;
  useEffect(() => {
    if (!showing) return;
    const flash = setInterval(() => {
      setLit((current) => !current);
    }, FLASH_MS);
    const stop = setTimeout(() => {
      setUntil(0);
    }, until - Date.now());
    return () => {
      clearInterval(flash);
      clearTimeout(stop);
    };
  }, [showing, until]);

  if (!showing || device === undefined) return null;
  return (
    <View
      testID="locate-overlay"
      accessibilityRole="alert"
      style={[styles.overlay, { backgroundColor: lit ? colors.accent : colors.background }]}
    >
      <Text style={[styles.text, { color: lit ? colors.onAccent : colors.text }]}>
        {t('mobile.tablet.locating', { name: device.name })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { fontSize: fontSize['3xl'], fontWeight: weight(fontWeight.bold) },
});
