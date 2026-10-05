import type { ItemView } from '@rp/contracts';
import { Button, ChoiceGroup, Icon, IconButton, Select, TextField } from '@rp/ui-web';
import { useT } from '../../app/i18n.js';
import {
  type ComboForm,
  type ComboPartForm,
  type ComboProblems,
  emptyComboPart,
} from './menu-view.js';

/**
 * The combo part of the item editor (MENU-005): fixed items and choices ("any 1 drink"), each with
 * a quantity, and an optional date range and daily time window. Once an item is a combo it stays
 * one; archiving it stops the sale.
 */
export function ComboSection({
  form,
  problems,
  submitted,
  choices,
  nameOf,
  wasCombo,
  partOfCombo,
  onChange,
}: {
  form: ComboForm;
  problems: ComboProblems;
  submitted: boolean;
  /** Items a combo can bundle. */
  choices: readonly ItemView[];
  /** The name of any item, archived ones included. */
  nameOf: (itemId: string) => string;
  /** The item is a combo already: it cannot stop being one. */
  wasCombo: boolean;
  /** The item is part of another combo: it cannot be a combo itself. */
  partOfCombo: boolean;
  onChange: (form: ComboForm) => void;
}) {
  const t = useT();
  const problemOf = (field: string): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? t(`menuEditor.combo.${problem}`) : undefined;
  };
  const setPart = (key: string, change: Partial<ComboPartForm>) => {
    onChange({
      ...form,
      parts: form.parts.map((part) => (part.key === key ? { ...part, ...change } : part)),
    });
  };
  const partsProblem = problemOf('parts');

  return (
    <fieldset className="menu-editor__section">
      <legend className="menu-editor__legend">{t('menuEditor.combo.title')}</legend>
      <p className="rp-field__hint">{t('menuEditor.combo.intro')}</p>
      {partOfCombo && !wasCombo ? (
        <p className="menu-editor__note">{t('menuEditor.combo.partOfCombo')}</p>
      ) : (
        <label className="console-check">
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={wasCombo}
            onChange={(event) => {
              const enabled = event.target.checked;
              onChange({
                ...form,
                enabled,
                parts: enabled && form.parts.length === 0 ? [emptyComboPart()] : form.parts,
              });
            }}
          />
          {t('menuEditor.combo.make')}
        </label>
      )}
      {wasCombo ? <p className="rp-field__hint">{t('menuEditor.combo.archiveToStop')}</p> : null}
      {form.enabled ? (
        <>
          {choices.length === 0 ? (
            <p className="console-notice">{t('menuEditor.combo.noItems')}</p>
          ) : null}
          {form.parts.map((part, index) => (
            <ComboPart
              key={part.key}
              part={part}
              number={index + 1}
              choices={choices}
              nameOf={nameOf}
              problemOf={problemOf}
              removable={form.parts.length > 1}
              onChange={(change) => {
                setPart(part.key, change);
              }}
              onRemove={() => {
                onChange({ ...form, parts: form.parts.filter((other) => other.key !== part.key) });
              }}
            />
          ))}
          {partsProblem === undefined ? null : <p className="rp-field__error">{partsProblem}</p>}
          {form.parts.length < 10 ? (
            <div>
              <Button
                variant="secondary"
                startIcon={<Icon name="plus" />}
                onClick={() => {
                  onChange({ ...form, parts: [...form.parts, emptyComboPart()] });
                }}
              >
                {t('menuEditor.combo.addPart')}
              </Button>
            </div>
          ) : null}
          <fieldset className="menu-editor__subsection">
            <legend className="menu-editor__legend">{t('menuEditor.combo.dates')}</legend>
            <p className="rp-field__hint">{t('menuEditor.combo.datesHint')}</p>
            <div className="menu-editor__row">
              <TextField
                type="date"
                label={t('menuEditor.combo.from')}
                value={form.activeFrom}
                onChange={(event) => {
                  onChange({ ...form, activeFrom: event.target.value });
                }}
              />
              <TextField
                type="date"
                label={t('menuEditor.combo.until')}
                value={form.activeUntil}
                error={problemOf('dates')}
                onChange={(event) => {
                  onChange({ ...form, activeUntil: event.target.value });
                }}
              />
            </div>
          </fieldset>
          <fieldset className="menu-editor__subsection">
            <legend className="menu-editor__legend">{t('menuEditor.combo.window')}</legend>
            <p className="rp-field__hint">{t('menuEditor.combo.windowHint')}</p>
            <div className="menu-editor__row">
              <TextField
                type="time"
                label={t('menuEditor.combo.start')}
                value={form.start}
                onChange={(event) => {
                  onChange({ ...form, start: event.target.value });
                }}
              />
              <TextField
                type="time"
                label={t('menuEditor.combo.end')}
                value={form.end}
                error={problemOf('window')}
                onChange={(event) => {
                  onChange({ ...form, end: event.target.value });
                }}
              />
            </div>
          </fieldset>
        </>
      ) : null}
    </fieldset>
  );
}

/** One part: a fixed item or a choice among items, and how many. */
function ComboPart({
  part,
  number,
  choices,
  nameOf,
  problemOf,
  removable,
  onChange,
  onRemove,
}: {
  part: ComboPartForm;
  number: number;
  choices: readonly ItemView[];
  nameOf: (itemId: string) => string;
  problemOf: (field: string) => string | undefined;
  removable: boolean;
  onChange: (change: Partial<ComboPartForm>) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const offered = new Set(choices.map((item) => item.id));
  const fixedOptions = [
    ...choices.map((item) => ({ value: item.id, label: item.name })),
    // An item archived (or made a combo) since keeps showing until it is replaced.
    ...(part.itemId !== '' && !offered.has(part.itemId)
      ? [{ value: part.itemId, label: nameOf(part.itemId), disabled: true }]
      : []),
  ];
  return (
    <fieldset className="menu-editor__subsection menu-combo-part">
      <legend className="menu-editor__legend">{t('menuEditor.combo.part', { number })}</legend>
      <ChoiceGroup
        legend={t('menuEditor.combo.kind', { number })}
        mode="single"
        options={[
          { id: 'FIXED', label: t('menuEditor.combo.fixed') },
          { id: 'CHOICE', label: t('menuEditor.combo.choice') },
        ]}
        value={[part.kind]}
        onChange={([kind]) => {
          if (kind === 'FIXED' || kind === 'CHOICE') onChange({ kind });
        }}
      />
      {part.kind === 'FIXED' ? (
        <Select
          label={t('menuEditor.combo.item')}
          placeholder={t('menuEditor.combo.chooseItem')}
          value={part.itemId}
          options={fixedOptions}
          error={problemOf(`part:${part.key}:item`)}
          onChange={(event) => {
            onChange({ itemId: event.target.value });
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
            error={problemOf(`part:${part.key}:label`)}
            onChange={(event) => {
              onChange({ label: event.target.value });
            }}
          />
          <div className="menu-field-group">
            <p className="rp-field__label">{t('menuEditor.combo.choices')}</p>
            {part.itemIds.length === 0 ? null : (
              <ul className="menu-chips">
                {part.itemIds.map((itemId) => (
                  <li key={itemId} className="menu-chips__chip">
                    <span>{nameOf(itemId)}</span>
                    <IconButton
                      label={t('menuEditor.combo.removeChoice', { name: nameOf(itemId) })}
                      icon={<Icon name="close" />}
                      onClick={() => {
                        onChange({ itemIds: part.itemIds.filter((other) => other !== itemId) });
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
            <Select
              label={t('menuEditor.combo.addChoice')}
              placeholder={t('menuEditor.combo.chooseItem')}
              value=""
              options={choices
                .filter((item) => !part.itemIds.includes(item.id))
                .map((item) => ({ value: item.id, label: item.name }))}
              error={problemOf(`part:${part.key}:choices`)}
              onChange={(event) => {
                const itemId = event.target.value;
                if (itemId !== '') onChange({ itemIds: [...part.itemIds, itemId] });
              }}
            />
          </div>
        </>
      )}
      <TextField
        label={t('menuEditor.combo.quantity')}
        inputMode="numeric"
        autoComplete="off"
        value={part.quantity}
        maxLength={2}
        className="menu-editor__short"
        error={problemOf(`part:${part.key}:quantity`)}
        onChange={(event) => {
          onChange({ quantity: event.target.value });
        }}
      />
      {removable ? (
        <div>
          <Button variant="ghost" onClick={onRemove}>
            {t('menuEditor.combo.removePart', { number })}
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}
