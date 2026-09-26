import { ApiRequestError } from '@rp/api-client';
import type { StaffTile } from '@rp/contracts';
import { canApproveOverride, type Capability } from '@rp/domain';
import { Button, Dialog, EmptyState, PinPad } from '@rp/ui-web';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';

/** The cashier closed the approval without a manager: the action is not taken. */
export class OverrideCancelled extends Error {
  constructor() {
    super('The manager approval was cancelled');
    this.name = 'OverrideCancelled';
  }
}

interface Pending {
  readonly capability: Capability;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly resolve: (token: string) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Manager approval in place (AUTH-011): an action is tried as the cashier; when the server answers
 * OVERRIDE_REQUIRED, a manager chooses their name and enters their PIN on this screen, and the
 * action is sent again with the single-use approval. The approval is for this capability and
 * record only.
 */
export function useOverride(): {
  withOverride: <T>(
    action: (overrideToken: string | undefined) => Promise<T>,
    context?: { entityType?: string; entityId?: string },
  ) => Promise<T>;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<Pending | undefined>();

  const withOverride = useCallback(
    async <T,>(
      action: (overrideToken: string | undefined) => Promise<T>,
      context: { entityType?: string; entityId?: string } = {},
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

  const dialog =
    pending === undefined ? null : (
      <OverrideDialog
        pending={pending}
        onDone={() => {
          setPending(undefined);
        }}
      />
    );
  return { withOverride, dialog };
}

function OverrideDialog({ pending, onDone }: { pending: Pending; onDone: () => void }) {
  const t = useT();
  const controller = useConsole();
  const [managers, setManagers] = useState<StaffTile[] | undefined>();
  const [chosen, setChosen] = useState<StaffTile | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    controller.staffTiles().then(
      (staff) => {
        if (active) setManagers(staff.filter((person) => canApproveOverride(person.role)));
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
  }, [controller, t]);

  const cancel = () => {
    pending.reject(new OverrideCancelled());
    onDone();
  };

  const approve = async (pin: string) => {
    if (chosen === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const granted = await controller.api.grantOverride({
        body: {
          approverStaffId: chosen.staffId,
          pin,
          capability: pending.capability,
          ...(pending.entityType !== undefined && { entityType: pending.entityType }),
          ...(pending.entityId !== undefined && { entityId: pending.entityId }),
        },
      });
      pending.resolve(granted.overrideToken);
      onDone();
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={cancel}
      dismissible={!busy}
      title={t('override.title')}
      description={t('override.description')}
    >
      {managers?.length === 0 ? <EmptyState title={error ?? t('override.noManagers')} /> : null}
      {chosen === undefined ? (
        <div className="console-choices" role="group" aria-label={t('override.manager')}>
          {(managers ?? []).map((manager) => (
            <Button
              key={manager.staffId}
              variant="secondary"
              onClick={() => {
                setChosen(manager);
              }}
            >
              {manager.displayName}
            </Button>
          ))}
        </div>
      ) : (
        <PinPad
          label={`${t('override.pin')}: ${chosen.displayName}`}
          onComplete={(pin) => {
            void approve(pin);
          }}
          error={error}
          busy={busy}
          autoFocus
        />
      )}
    </Dialog>
  );
}
