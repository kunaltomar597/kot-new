import type { MenuDraftResponse } from '@rp/contracts';
import { Button, ChoiceGroup, Icon, IconButton, Select, TextField } from '@rp/ui-web';
import { useT } from '../../app/i18n.js';
import {
  type ComboField,
  type ComboForm,
  type ComboPartForm,
  type ComboProblem,
  comboCandidates,
  newComboPart,
} from './menu-view.js';

/**
 * A combo's parts (MENU-005): set dishes ("2 rotis") and choices ("any 1 drink" among several
 * dishes), with optional dates and daily hours. Only active dishes that are not combos themselves
 * can be parts.
 */
export function ComboFields({
  draft,
  comboItemId,
  form,
  problems,
  onChange,
}: {
  draft: MenuDraftResponse;
  comboItemId: string | undefined;
  form: ComboForm;
  problems: Partial<Record<ComboField, ComboProblem>>;
  onChange: (form: ComboForm) => void;
}) {
  const t = useT();
  const candidates = comboCandidates(draft, comboItemId);
  const problemOf = (field: ComboField) => {
    const problem = problems[field];
    return problem === undefined ? undefined : t(`menuEditor.combo.problems.${problem}`);
  };
  const setPart = (index: number, part: ComboPartForm) => {
    const parts = [...form.parts];
    parts[index] = part;
    onChange({ ...form, parts });
  };

  return (
    <div className="menu-combo">
      {form.parts.map((part, index) => (
        <fieldset className="menu-combo__part" key={part.key}>
          <legend>
            {t('menuEditor.combo.part', {
              number: index + 1,
              kind:
                part.kind === 'FIXED' ? t('menuEditor.combo.fixed') : t('menuEditor.combo.choice'),
            })}
          </legend>
          {part.kind === 'FIXED' ? (
            <Select
              label={t('menuEditor.combo.dish')}
              value={part.itemId}
              options={[
                { value: '', label: t('menuEditor.combo.chooseDish') },
                ...candidates.map((item) => ({ value: item.id, label: item.name })),
              ]}
              onChange={(event) => {
                setPart(index, { ...part, itemId: event.target.value });
              }}
            />
          ) : (
            <>
              <TextField
                label={t('menuEditor.combo.label')}
                hint={t('menuEditor.combo.labelHint')}
                value={part.label}
                maxLength={60}
                autoComplete="off"
                onChange={(event) => {
                  setPart(index, { ...part, label: event.target.value });
                }}
              />
              <ChoiceGroup
                legend={t('menuEditor.combo.choices')}
                mode="multiple"
                max={30}
                options={candidates.map((item) => ({ id: item.id, label: item.name }))}
                value={[...part.itemIds]}
                onChange={(itemIds) => {
                  setPart(index, { ...part, itemIds });
                }}
              />
            </>
          )}
          <div className="menu-form__row">
            <TextField
              label={t('menuEditor.combo.quantity')}
              value={part.quantity}
              inputMode="numeric"
              autoComplete="off"
              onChange={(event) => {
                setPart(index, { ...part, quantity: event.target.value });
              }}
            />
            {form.parts.length === 1 ? null : (
              <IconButton
                label={t('menuEditor.combo.removePart', { number: index + 1 })}
                icon={<Icon name="close" />}
                onClick={() => {
                  onChange({
                    ...form,
                    parts: form.parts.filter((entry) => entry.key !== part.key),
                  });
                }}
              />
            )}
          </div>
        </fieldset>
      ))}
      {problemOf('parts') === undefined ? null : (
        <p role="alert" className="menu-form__error">
          {problemOf('parts')}
        </p>
      )}
      {form.parts.length >= 10 ? null : (
        <div className="staff-row__actions">
          <Button
            variant="secondary"
            startIcon={<Icon name="plus" />}
            onClick={() => {
              onChange({ ...form, parts: [...form.parts, newComboPart('FIXED')] });
            }}
          >
            {t('menuEditor.combo.addFixed')}
          </Button>
          <Button
            variant="secondary"
            startIcon={<Icon name="plus" />}
            onClick={() => {
              onChange({ ...form, parts: [...form.parts, newComboPart('CHOICE')] });
            }}
          >
            {t('menuEditor.combo.addChoice')}
          </Button>
        </div>
      )}
      <p className="menu-form__hint">{t('menuEditor.combo.datesHint')}</p>
      <div className="menu-form__row">
        <TextField
          label={t('menuEditor.combo.from')}
          type="date"
          value={form.activeFrom}
          onChange={(event) => {
            onChange({ ...form, activeFrom: event.target.value });
          }}
        />
        <TextField
          label={t('menuEditor.combo.until')}
          type="date"
          value={form.activeUntil}
          error={problemOf('dates')}
          onChange={(event) => {
            onChange({ ...form, activeUntil: event.target.value });
          }}
        />
      </div>
      <p className="menu-form__hint">{t('menuEditor.combo.windowHint')}</p>
      <div className="menu-form__row">
        <TextField
          label={t('menuEditor.combo.windowStart')}
          type="time"
          value={form.windowStart}
          onChange={(event) => {
            onChange({ ...form, windowStart: event.target.value });
          }}
        />
        <TextField
          label={t('menuEditor.combo.windowEnd')}
          type="time"
          value={form.windowEnd}
          error={problemOf('window')}
          onChange={(event) => {
            onChange({ ...form, windowEnd: event.target.value });
          }}
        />
      </div>
    </div>
  );
}
