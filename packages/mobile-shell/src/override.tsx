import { ApiRequestError } from '@rp/api-client';
import type { StaffTile } from '@rp/contracts';
import { spacing } from '@rp/design-tokens';
import { canApproveOverride, type Capability } from '@rp/domain';
import { Button, PinPad, Sheet } from '@rp/ui-native';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useDeviceSession, useSessionState, useT } from './context.js';
import { messageOf } from './messages.js';
import { Note } from './Screen.js';

/** The manager approval was closed without a PIN: the action is not taken. */
export class OverrideCancelled extends Error {
  constructor() {
    super('The manager approval was cancelled');
    this.name = 'OverrideCancelled';
  }
}

/** The record an approval is for, kept with it and in the audit log. */
export interface OverrideContext {
  readonly entityType?: string;
  readonly entityId?: string;
}

interface Pending extends OverrideContext {
  readonly capability: Capability;
  readonly resolve: (token: string) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Manager approval on the phone (AUTH-011, WTR-009): an action is tried as the signed-in person;
 * when the server answers OVERRIDE_REQUIRED, a manager picks their name and enters their PIN on
 * this device, and the action is sent again with the single-use approval, which is for that
 * capability and record only. Render `sheet` next to the screen that uses it. The twin of the
 * console's `useOverride`.
 */
export function useOverride(): {
  withOverride: <T>(
    action: (overrideToken: string | undefined) => Promise<T>,
    context?: OverrideContext,
  ) => Promise<T>;
  sheet: ReactNode;
} {
  const [pending, setPending] = useState<Pending | undefined>();

  const withOverride = useCallback(
    async <T,>(
      action: (overrideToken: string | undefined) => Promise<T>,
      context: OverrideContext = {},
    ): Promise<T> => {
      try {
        return await action(undefined);
      } catch (error) {
        if (!(error instanceof ApiRequestError) || error.code !== 'OVERRIDE_REQUIRED') throw error;
        const capability = error.details?.capability as Capability;
        const token = await new Promise<string>((resolve, reject) => {
          setPending({ capability, ...context, resolve, reject });
        });
        return action(token);
      }
    },
    [],
  );

  const sheet =
    pending === undefined ? null : (
      <OverrideSheet
        pending={pending}
        onDone={() => {
          setPending(undefined);
        }}
      />
    );
  return { withOverride, sheet };
}

function OverrideSheet({ pending, onDone }: { pending: Pending; onDone: () => void }) {
  const session = useDeviceSession();
  const { person } = useSessionState();
  const t = useT();
  const [managers, setManagers] = useState<StaffTile[] | undefined>();
  const [chosen, setChosen] = useState<StaffTile | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    session.staffTiles().then(
      (staff) => {
        // The person asking cannot approve their own action (AUTH-011).
        if (active) {
          setManagers(
            staff.filter((tile) => canApproveOverride(tile.role) && tile.staffId !== person?.id),
          );
        }
      },
      (failure: unknown) => {
        if (active) {
          setManagers([]);
          setError(messageOf(failure, t));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [session, person, t]);

  const cancel = () => {
    pending.reject(new OverrideCancelled());
    onDone();
  };

  const approve = (pin: string) => {
    if (chosen === undefined) return;
    setBusy(true);
    setError(null);
    session.api
      .grantOverride({
        body: {
          approverStaffId: chosen.staffId,
          pin,
          capability: pending.capability,
          ...(pending.entityType !== undefined && { entityType: pending.entityType }),
          ...(pending.entityId !== undefined && { entityId: pending.entityId }),
        },
      })
      .then(
        (granted) => {
          pending.resolve(granted.overrideToken);
          onDone();
        },
        (failure: unknown) => {
          setError(messageOf(failure, t));
          setBusy(false);
        },
      );
  };

  return (
    <Sheet open onClose={cancel} dismissible={!busy} title={t('override.title')}>
      <Note>{t('override.description')}</Note>
      {managers === undefined ? <Note>{t('states.loading')}</Note> : null}
      {managers?.length === 0 ? (
        <Note tone="danger">{error ?? t('override.noManagers')}</Note>
      ) : null}
      {chosen === undefined ? (
        <View accessibilityLabel={t('override.manager')} style={styles.choices}>
          {(managers ?? []).map((manager) => (
            <Button
              key={manager.staffId}
              testID={`approver-${manager.staffId}`}
              variant="secondary"
              size="lg"
              fullWidth
              onPress={() => {
                setChosen(manager);
              }}
            >
              {manager.displayName}
            </Button>
          ))}
        </View>
      ) : (
        <>
          <PinPad
            label={`${t('override.pin')}: ${chosen.displayName}`}
            onComplete={approve}
            error={error}
            busy={busy}
          />
          <Button
            variant="ghost"
            disabled={busy}
            onPress={() => {
              setChosen(undefined);
              setError(null);
            }}
          >
            {t('override.otherManager')}
          </Button>
        </>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  choices: { gap: spacing[2] },
});
