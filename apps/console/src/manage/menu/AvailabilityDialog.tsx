import type { ItemView } from '@rp/contracts';
import { Button, ChoiceGroup, Dialog, TextField } from '@rp/ui-web';
import { useId, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { type AvailabilityForm, availabilityFormOf, availabilityRequestOf } from './menu-view.js';

/**
 * Marks an item available or out of stock and counts what is left (MENU-006). It applies on every
 * screen at once, without publishing; each order takes from the count, and at 0 the item goes out
 * of stock by itself.
 */
export function AvailabilityDialog({
  item,
  onSaved,
  onClose,
}: {
  item: ItemView;
  onSaved: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const formId = useId();
  const [form, setForm] = useState<AvailabilityForm>(() => availabilityFormOf(item));
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const request = availabilityRequestOf(form);
  const save = async () => {
    setSubmitted(true);
    if (request === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await controller.api.setItemAvailability({ params: { id: item.id }, body: request });
      onSaved();
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={t('menuEditor.availabilityDialog.title', { name: item.name })}
      description={t('menuEditor.availabilityDialog.description')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('menuEditor.availabilityDialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('menuEditor.availabilityDialog.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="console-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <ChoiceGroup
          legend={t('menuEditor.availabilityDialog.state')}
          mode="single"
          options={[
            { id: 'AVAILABLE', label: t('menuEditor.availabilityDialog.available') },
            { id: 'OUT', label: t('menuEditor.availabilityDialog.outOfStock') },
          ]}
          value={[form.available ? 'AVAILABLE' : 'OUT']}
          onChange={([choice]) => {
            setForm((current) => ({ ...current, available: choice === 'AVAILABLE' }));
          }}
        />
        <div className="menu-field-group">
          <label className="console-check">
            <input
              type="checkbox"
              checked={form.counting}
              onChange={(event) => {
                const { checked } = event.target;
                setForm((current) => ({ ...current, counting: checked }));
              }}
            />
            {t('menuEditor.availabilityDialog.count')}
          </label>
          <p className="rp-field__hint">{t('menuEditor.availabilityDialog.countHint')}</p>
        </div>
        {form.counting ? (
          <TextField
            label={t('menuEditor.availabilityDialog.left')}
            inputMode="numeric"
            autoComplete="off"
            value={form.left}
            maxLength={6}
            required
            error={
              submitted && request === undefined
                ? t('menuEditor.availabilityDialog.leftInvalid')
                : undefined
            }
            onChange={(event) => {
              const left = event.target.value;
              setForm((current) => ({ ...current, left }));
            }}
          />
        ) : null}
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
