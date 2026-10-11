import type { RemoteSettingDefinition, RemoteSettingValues } from '@rp/contracts/control-plane';
import { Button, Dialog, Select, TextField } from '@rp/ui-web';
import { useState } from 'react';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { draftOf, type RemoteDraft, valuesOf } from './remote-form.js';

/** A setting's value as people read it: on/off, a number with its unit, or "default". */
export function shownValue(
  definition: RemoteSettingDefinition,
  value: unknown,
  t: ReturnType<typeof useT>,
): string {
  if (value === undefined) return t('vendorApp.remote.default');
  if (typeof value === 'boolean')
    return value ? t('vendorApp.remote.on') : t('vendorApp.remote.off');
  const text =
    typeof value === 'number' || typeof value === 'string' ? String(value) : JSON.stringify(value);
  return definition.unit === null ? text : `${text} ${definition.unit}`;
}

/**
 * Edits vendor settings and feature flags (UPD-010): each one set, or left at its default (or
 * the fleet's value, for one PC), with the reason the audit log keeps.
 */
export function RemoteSettingsEditor({
  title,
  intro,
  definitions,
  values,
  onClose,
  onSave,
}: {
  title: string;
  intro: string;
  definitions: readonly RemoteSettingDefinition[];
  values: RemoteSettingValues;
  onClose: () => void;
  onSave: (values: RemoteSettingValues, reason: string) => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState<RemoteDraft>(() => draftOf(definitions, values));
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const set = (key: string, text: string) => {
    setDraft({ ...draft, [key]: text });
  };
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={title}
      description={intro}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('vendorApp.actions.cancel')}
          </Button>
          <Button
            loading={busy}
            disabled={busy || reason.trim().length < 3}
            onClick={() => {
              const result = valuesOf(definitions, draft);
              setInvalid(result.invalid);
              if (result.invalid.length > 0) return;
              setBusy(true);
              setError(undefined);
              onSave(result.values, reason.trim()).catch((failure: unknown) => {
                setBusy(false);
                setError(messageOf(failure, t));
              });
            }}
          >
            {t('vendorApp.actions.save')}
          </Button>
        </>
      }
    >
      <div className="cp-form cp-form--grid">
        {definitions.map((definition) =>
          definition.kind === 'BOOLEAN' ? (
            <Select
              key={definition.key}
              label={definition.key}
              hint={definition.description}
              value={draft[definition.key] ?? ''}
              options={[
                {
                  value: '',
                  label: t('vendorApp.remote.keep', {
                    value: shownValue(definition, definition.defaultValue, t),
                  }),
                },
                { value: 'true', label: t('vendorApp.remote.on') },
                { value: 'false', label: t('vendorApp.remote.off') },
              ]}
              onChange={(event) => {
                set(definition.key, event.target.value);
              }}
            />
          ) : (
            <TextField
              key={definition.key}
              label={definition.key}
              hint={t('vendorApp.remote.numberHint', {
                description: definition.description,
                min: definition.min ?? 0,
                max: definition.max ?? 0,
                value: shownValue(definition, definition.defaultValue, t),
              })}
              inputMode="numeric"
              value={draft[definition.key] ?? ''}
              error={invalid.includes(definition.key) ? t('vendorApp.remote.invalid') : undefined}
              onChange={(event) => {
                set(definition.key, event.target.value);
              }}
            />
          ),
        )}
      </div>
      <TextField
        label={t('vendorApp.reason.label')}
        hint={t('vendorApp.reason.hint')}
        value={reason}
        maxLength={200}
        onChange={(event) => {
          setReason(event.target.value);
        }}
      />
      {error === undefined ? null : (
        <p role="alert" className="cp-notice cp-notice--danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}
