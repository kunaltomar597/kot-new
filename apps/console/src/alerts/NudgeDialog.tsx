import { NUDGE_MESSAGE_MAX, NUDGE_STAFF_MAX, type StaffTile } from '@rp/contracts';
import {
  Button,
  ChoiceGroup,
  Dialog,
  EmptyState,
  LoadingState,
  TextField,
  useToast,
} from '@rp/ui-web';
import { useEffect, useState } from 'react';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import type { LiveData } from '../app/use-live.js';

/** The restaurant's one-tap messages (`notifications.nudgePresets`), as far as they are valid. */
export function presetsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (preset): preset is string =>
      typeof preset === 'string' &&
      preset.trim() !== '' &&
      preset.trim().length <= NUDGE_MESSAGE_MAX,
  );
}

/**
 * A manager's nudge (P2-06c, NTF-008): choose one or more waiters, then a quick message or up to
 * 40 characters of their own. Each waiter's pager and phone buzz with it until they acknowledge.
 */
export function NudgeDialog({ onClose }: { onClose: () => void }) {
  const controller = useConsole();
  const t = useT();
  const toast = useToast();
  const [waiters, setWaiters] = useState<LiveData<readonly StaffTile[]>>({ status: 'loading' });
  const [presets, setPresets] = useState<readonly string[]>([]);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let live = true;
    controller.staffTiles().then(
      (tiles) => {
        if (live) {
          setWaiters({ status: 'ready', value: tiles.filter((tile) => tile.role === 'WAITER') });
        }
      },
      (failure: unknown) => {
        if (live) setWaiters({ status: 'error', error: failure });
      },
    );
    controller.api.listSettings().then(
      ({ settings }) => {
        const setting = settings.find((entry) => entry.key === 'notifications.nudgePresets');
        if (live) setPresets(presetsOf(setting?.value));
      },
      () => {
        // Without the quick messages the manager types one.
      },
    );
    return () => {
      live = false;
    };
  }, [controller]);

  const text = message.trim();
  const ready = chosen.length > 0 && text !== '' && text.length <= NUDGE_MESSAGE_MAX;

  const send = async () => {
    setSending(true);
    setError(undefined);
    try {
      await controller.api.nudgeStaff({ body: { staffIds: [...chosen], message: text } });
      const first =
        waiters.status === 'ready'
          ? (waiters.value.find((waiter) => waiter.staffId === chosen[0])?.displayName ?? '')
          : '';
      toast.show({
        title: t('alerts.nudge.sent', { count: chosen.length, name: first }),
        tone: 'success',
      });
      onClose();
    } catch (failure) {
      setError(messageOf(failure, t));
      setSending(false);
    }
  };

  let people;
  if (waiters.status === 'loading') {
    people = <LoadingState title={t('states.loading')} />;
  } else if (waiters.status === 'error') {
    people = (
      <p role="alert" className="console-notice console-notice--danger">
        {t('alerts.nudge.staffFailed', { message: messageOf(waiters.error, t) })}
      </p>
    );
  } else if (waiters.value.length === 0) {
    people = <EmptyState icon="users" title={t('alerts.nudge.noWaiters')} />;
  } else {
    people = (
      <ChoiceGroup
        legend={t('alerts.nudge.waiters')}
        hint={t('alerts.nudge.waitersHint')}
        mode="multiple"
        max={NUDGE_STAFF_MAX}
        options={waiters.value.map((waiter) => ({ id: waiter.staffId, label: waiter.displayName }))}
        value={chosen}
        onChange={setChosen}
      />
    );
  }

  return (
    <Dialog
      open
      size="md"
      onClose={onClose}
      dismissible={!sending}
      title={t('alerts.nudge.title')}
      description={t('alerts.nudge.description')}
      footer={
        <Button
          disabled={!ready}
          loading={sending}
          onClick={() => {
            void send();
          }}
        >
          {t('alerts.nudge.send')}
        </Button>
      }
    >
      {error === undefined ? null : (
        <p role="alert" className="console-notice console-notice--danger">
          {error}
        </p>
      )}
      <div className="nudge">
        {people}
        {presets.length === 0 ? null : (
          <fieldset className="nudge__presets">
            <legend className="nudge__legend">{t('alerts.nudge.presets')}</legend>
            {presets.map((preset) => (
              <Button
                key={preset}
                variant={text === preset.trim() ? 'primary' : 'secondary'}
                aria-pressed={text === preset.trim()}
                onClick={() => {
                  setMessage(preset.trim());
                }}
              >
                {preset}
              </Button>
            ))}
          </fieldset>
        )}
        <TextField
          label={t('alerts.nudge.message')}
          hint={t('alerts.nudge.messageHint', {
            count: message.length,
            max: NUDGE_MESSAGE_MAX,
          })}
          value={message}
          maxLength={NUDGE_MESSAGE_MAX}
          autoComplete="off"
          onChange={(event) => {
            setMessage(event.target.value);
          }}
        />
      </div>
    </Dialog>
  );
}
