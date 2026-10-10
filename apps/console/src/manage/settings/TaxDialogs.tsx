import type { InvoiceSeriesView, RestaurantProfile, TaxGroupView } from '@rp/contracts';
import { GST_STATE_CODES, type IsoDate } from '@rp/domain';
import { Button, ChoiceGroup, Icon, Select, TextField } from '@rp/ui-web';
import { useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { SecondFactorCancelled, type WithSecondFactor } from '../../owner/second-factor.js';
import { FormDialog, ReasonField } from './FormDialog.js';
import { reasonProblemOf } from './restaurant-view.js';
import { percentOf } from './settings-view.js';
import {
  checkLegal,
  checkSeries,
  checkTaxGroup,
  emptySeriesForm,
  emptyTaxGroupForm,
  formatIsFixed,
  type LegalField,
  type LegalForm,
  legalFormOf,
  legalRequestOf,
  MAX_COMPONENTS,
  SEPARATORS,
  type Separator,
  type SeriesField,
  type SeriesForm,
  seriesExampleOf,
  seriesFormOf,
  seriesRequestOf,
  stateChoices,
  stateOfGstin,
  type TaxComponentForm,
  type TaxGroupForm,
  taxGroupFormOf,
  taxGroupIsValid,
  taxGroupRequestOf,
  typedTotalBp,
} from './tax-view.js';

const SEPARATOR_NAMES = { '/': 'SLASH', '-': 'DASH' } as const satisfies Record<Separator, string>;
const isSeparator = (value: string): value is Separator =>
  SEPARATORS.some((separator) => separator === value);

/**
 * An Owner-only change (AUTH-006): sent with the second factor asked for when the server wants
 * it. A closed confirmation leaves the dialog as it was; any refusal stays in the dialog.
 */
function useOwnerSave<T>(withSecondFactor: WithSecondFactor, onSaved: (saved: T) => void) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const save = async (action: (reason: string) => Promise<T>) => {
    setBusy(true);
    setError(undefined);
    try {
      onSaved(await withSecondFactor(() => action(reason)));
    } catch (failure) {
      if (!(failure instanceof SecondFactorCancelled)) setError(messageOf(failure, t));
      setBusy(false);
    }
  };
  return { reason, setReason, busy, error, save };
}

/**
 * The particulars printed on every tax invoice (BILL-002, ONB-004 step 1): the legal name, the
 * address, the state that is the place of supply, the GSTIN (checked character by character, and
 * the state taken from it when none is chosen yet) and the FSSAI number. The Owner's, after the
 * second factor.
 */
export function LegalDialog({
  profile,
  withSecondFactor,
  onSaved,
  onClose,
}: {
  profile: RestaurantProfile;
  withSecondFactor: WithSecondFactor;
  onSaved: (saved: RestaurantProfile) => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const { reason, setReason, busy, error, save } = useOwnerSave(withSecondFactor, onSaved);
  const [form, setForm] = useState<LegalForm>(() => legalFormOf(profile));
  const [submitted, setSubmitted] = useState(false);

  const problems = checkLegal(form);
  const problemOf = (field: LegalField): string | undefined => {
    const problem = problems[field];
    if (!submitted || problem === undefined) return undefined;
    return problem === 'gstinOtherState'
      ? t('tax.legalDialog.problems.gstinOtherState', {
          code: form.stateCode,
          name: GST_STATE_CODES[form.stateCode] ?? '',
        })
      : t(`tax.legalDialog.problems.${problem}`);
  };
  const set = <K extends keyof LegalForm>(key: K, value: LegalForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const text = (field: Exclude<LegalField, 'stateCode'>, label: string, maxLength: number) => (
    <TextField
      label={label}
      value={form[field]}
      maxLength={maxLength}
      autoComplete="off"
      error={problemOf(field)}
      onChange={(event) => {
        set(field, event.target.value);
      }}
    />
  );

  return (
    <FormDialog
      title={t('tax.legalDialog.title')}
      description={t('tax.legalDialog.description')}
      busy={busy}
      error={error}
      onConfirm={() => {
        setSubmitted(true);
        if (Object.keys(problems).length > 0 || reasonProblemOf(reason) !== undefined) return;
        void save((why) =>
          controller.api.updateRestaurantLegal({ body: legalRequestOf(form, why) }),
        );
      }}
      onClose={onClose}
    >
      <TextField
        label={t('tax.legalDialog.legalName')}
        hint={t('tax.legalDialog.legalNameHint')}
        value={form.legalName}
        maxLength={120}
        autoComplete="off"
        required
        data-autofocus
        error={problemOf('legalName')}
        onChange={(event) => {
          set('legalName', event.target.value);
        }}
      />
      {text('line1', t('tax.legalDialog.line1'), 120)}
      {text('line2', t('tax.legalDialog.line2'), 120)}
      {text('city', t('tax.legalDialog.city'), 60)}
      <TextField
        label={t('tax.legalDialog.pincode')}
        inputMode="numeric"
        value={form.pincode}
        maxLength={6}
        autoComplete="off"
        error={problemOf('pincode')}
        onChange={(event) => {
          set('pincode', event.target.value.replace(/\D/g, ''));
        }}
      />
      <Select
        label={t('tax.legalDialog.state')}
        hint={t('tax.legalDialog.stateHint')}
        value={form.stateCode}
        options={[
          { value: '', label: t('tax.legalDialog.chooseState') },
          ...stateChoices().map(({ code, name }) => ({
            value: code,
            label: t('tax.legal.stateValue', { name, code }),
          })),
        ]}
        error={problemOf('stateCode')}
        onChange={(event) => {
          set('stateCode', event.target.value);
        }}
      />
      <TextField
        label={t('tax.legalDialog.gstin')}
        hint={t('tax.legalDialog.gstinHint')}
        value={form.gstin}
        maxLength={20}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        error={problemOf('gstin')}
        onChange={(event) => {
          const gstin = event.target.value;
          setForm((current) => {
            // The GSTIN names its state: take it when none is chosen yet.
            const state = current.stateCode === '' ? stateOfGstin(gstin) : undefined;
            return { ...current, gstin, ...(state !== undefined && { stateCode: state }) };
          });
        }}
      />
      <TextField
        label={t('tax.legalDialog.fssai')}
        hint={t('tax.legalDialog.fssaiHint')}
        inputMode="numeric"
        value={form.fssaiNumber}
        maxLength={17}
        autoComplete="off"
        error={problemOf('fssaiNumber')}
        onChange={(event) => {
          set('fssaiNumber', event.target.value);
        }}
      />
      <ReasonField reason={reason} submitted={submitted} onChange={setReason} />
    </FormDialog>
  );
}

/**
 * Adds a tax group or changes one (BILL-004, ONB-004 step 2): its name, the SAC code printed on
 * the invoice and its taxes with their rates, in the order they print. Rates are typed as
 * percentages and sent in basis points. The Owner's, after the second factor.
 */
export function TaxGroupDialog({
  group,
  groups,
  withSecondFactor,
  onSaved,
  onClose,
}: {
  /** Undefined to add one. */
  group: TaxGroupView | undefined;
  groups: readonly TaxGroupView[];
  withSecondFactor: WithSecondFactor;
  onSaved: (saved: TaxGroupView) => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const { reason, setReason, busy, error, save } = useOwnerSave(withSecondFactor, onSaved);
  const [form, setForm] = useState<TaxGroupForm>(() =>
    group === undefined ? emptyTaxGroupForm() : taxGroupFormOf(group),
  );
  const [submitted, setSubmitted] = useState(false);

  const check = checkTaxGroup(form, groups, group?.id);
  const total = typedTotalBp(form);
  const setComponents = (components: readonly TaxComponentForm[]) => {
    setForm((current) => ({ ...current, components }));
  };
  const setComponent = (index: number, change: Partial<TaxComponentForm>) => {
    setComponents(
      form.components.map((component, at) =>
        at === index ? { ...component, ...change } : component,
      ),
    );
  };

  return (
    <FormDialog
      title={
        group === undefined
          ? t('tax.groupDialog.addTitle')
          : t('tax.groupDialog.editTitle', { name: group.name })
      }
      busy={busy}
      error={error}
      onConfirm={() => {
        setSubmitted(true);
        if (!taxGroupIsValid(check) || reasonProblemOf(reason) !== undefined) return;
        void save((why) => {
          const body = taxGroupRequestOf(form, why);
          return group === undefined
            ? controller.api.createTaxGroup({ body })
            : controller.api.updateTaxGroup({ params: { taxGroupId: group.id }, body });
        });
      }}
      onClose={onClose}
    >
      <TextField
        label={t('tax.groupDialog.name')}
        hint={t('tax.groupDialog.nameHint')}
        value={form.name}
        maxLength={40}
        autoComplete="off"
        required
        data-autofocus
        error={
          submitted && check.name !== undefined
            ? t(`tax.groupDialog.problems.${check.name}`)
            : undefined
        }
        onChange={(event) => {
          const name = event.target.value;
          setForm((current) => ({ ...current, name }));
        }}
      />
      <TextField
        label={t('tax.groupDialog.sac')}
        hint={t('tax.groupDialog.sacHint')}
        inputMode="numeric"
        value={form.sacCode}
        maxLength={8}
        autoComplete="off"
        error={
          submitted && check.sacCode !== undefined
            ? t(`tax.groupDialog.problems.${check.sacCode}`)
            : undefined
        }
        onChange={(event) => {
          const sacCode = event.target.value.replace(/\D/g, '');
          setForm((current) => ({ ...current, sacCode }));
        }}
      />
      <fieldset className="menu-editor__section">
        <legend className="menu-editor__legend">{t('tax.groupDialog.taxes')}</legend>
        <p className="rp-field__hint">{t('tax.groupDialog.taxesHint')}</p>
        {form.components.map((component, index) => {
          const problems = check.components[index] ?? {};
          return (
            <fieldset key={index} className="settings-window">
              <legend className="settings-window__legend">
                {t('tax.groupDialog.taxLegend', { number: index + 1 })}
              </legend>
              <div className="settings-window__times">
                <TextField
                  label={t('tax.groupDialog.code')}
                  hint={t('tax.groupDialog.codeHint')}
                  value={component.code}
                  maxLength={10}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  error={
                    submitted && problems.code !== undefined
                      ? t(`tax.groupDialog.problems.${problems.code}`)
                      : undefined
                  }
                  onChange={(event) => {
                    setComponent(index, { code: event.target.value.toUpperCase() });
                  }}
                />
                <TextField
                  label={t('tax.groupDialog.rate')}
                  inputMode="decimal"
                  value={component.rate}
                  maxLength={6}
                  autoComplete="off"
                  endAdornment={t('settings.unitShort.percent')}
                  error={
                    submitted && problems.rate !== undefined
                      ? t(`tax.groupDialog.problems.${problems.rate}`)
                      : undefined
                  }
                  onChange={(event) => {
                    setComponent(index, { rate: event.target.value });
                  }}
                />
              </div>
              <div>
                <Button
                  variant="ghost"
                  aria-label={t('tax.groupDialog.removeLabel', { number: index + 1 })}
                  onClick={() => {
                    setComponents(form.components.filter((_, at) => at !== index));
                  }}
                >
                  {t('tax.groupDialog.removeTax')}
                </Button>
              </div>
            </fieldset>
          );
        })}
        <div>
          <Button
            variant="secondary"
            startIcon={<Icon name="plus" />}
            disabled={form.components.length >= MAX_COMPONENTS}
            onClick={() => {
              setComponents([...form.components, { code: '', rate: '' }]);
            }}
          >
            {t('tax.groupDialog.addTax')}
          </Button>
        </div>
        <p className="settings-row__value" aria-live="polite">
          {total === undefined ? null : t('tax.groupDialog.total', { rate: percentOf(total) })}
        </p>
        {submitted && check.total !== undefined ? (
          <p role="alert" className="rp-field__error">
            {t(`tax.groupDialog.problems.${check.total}`)}
          </p>
        ) : null}
      </fieldset>
      {group !== undefined && group.itemCount > 0 ? (
        <p className="console-notice">{t('tax.groupDialog.inUse', { count: group.itemCount })}</p>
      ) : null}
      <ReasonField reason={reason} submitted={submitted} onChange={setReason} />
    </FormDialog>
  );
}

/**
 * Adds an invoice series or changes one (BILL-003, ONB-004 step 3): its name and how its numbers
 * look, with the first number of this financial year as bills would get it. Once a series has
 * issued an invoice only its name changes. The Owner's, after the second factor.
 */
export function SeriesDialog({
  series,
  allSeries,
  today,
  withSecondFactor,
  onSaved,
  onClose,
}: {
  /** Undefined to add one. */
  series: InvoiceSeriesView | undefined;
  allSeries: readonly InvoiceSeriesView[];
  /** Today in the restaurant, for the example's financial year. */
  today: IsoDate;
  withSecondFactor: WithSecondFactor;
  onSaved: (saved: InvoiceSeriesView) => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const { reason, setReason, busy, error, save } = useOwnerSave(withSecondFactor, onSaved);
  const [form, setForm] = useState<SeriesForm>(() =>
    series === undefined ? emptySeriesForm() : seriesFormOf(series),
  );
  const [submitted, setSubmitted] = useState(false);
  const fixed = formatIsFixed(series);

  const problems = checkSeries(form, allSeries, series?.id);
  const problemOf = (field: SeriesField): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined
      ? t(`tax.seriesDialog.problems.${problem}`)
      : undefined;
  };
  const set = <K extends keyof SeriesForm>(key: K, value: SeriesForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const example = seriesExampleOf(form, today);

  return (
    <FormDialog
      title={
        series === undefined
          ? t('tax.seriesDialog.addTitle')
          : t('tax.seriesDialog.editTitle', { name: series.name })
      }
      busy={busy}
      error={error}
      onConfirm={() => {
        setSubmitted(true);
        if (Object.keys(problems).length > 0 || reasonProblemOf(reason) !== undefined) return;
        void save((why) => {
          const body = seriesRequestOf(form, why);
          return series === undefined
            ? controller.api.createInvoiceSeries({ body })
            : controller.api.updateInvoiceSeries({ params: { seriesId: series.id }, body });
        });
      }}
      onClose={onClose}
    >
      <TextField
        label={t('tax.seriesDialog.name')}
        hint={t('tax.seriesDialog.nameHint')}
        value={form.name}
        maxLength={40}
        autoComplete="off"
        required
        data-autofocus
        error={problemOf('name')}
        onChange={(event) => {
          set('name', event.target.value);
        }}
      />
      {fixed ? <p className="console-notice">{t('tax.seriesDialog.fixed')}</p> : null}
      <TextField
        label={t('tax.seriesDialog.prefix')}
        hint={t('tax.seriesDialog.prefixHint')}
        value={form.prefix}
        maxLength={10}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        disabled={fixed}
        error={problemOf('prefix')}
        onChange={(event) => {
          set('prefix', event.target.value.toUpperCase().replace(/\s+/g, ''));
        }}
      />
      <label className="console-check">
        <input
          type="checkbox"
          checked={form.includeFinancialYear}
          disabled={fixed}
          onChange={(event) => {
            set('includeFinancialYear', event.target.checked);
          }}
        />
        {t('tax.seriesDialog.year')}
      </label>
      <ChoiceGroup
        legend={t('tax.seriesDialog.separator')}
        mode="single"
        options={SEPARATORS.map((separator) => ({
          id: separator,
          label: t(`tax.seriesDialog.separators.${SEPARATOR_NAMES[separator]}`),
          disabled: fixed,
        }))}
        value={[form.separator]}
        onChange={([chosen]) => {
          if (chosen !== undefined && isSeparator(chosen)) set('separator', chosen);
        }}
      />
      <TextField
        label={t('tax.seriesDialog.digits')}
        hint={t('tax.seriesDialog.digitsHint')}
        inputMode="numeric"
        value={form.digits}
        maxLength={2}
        autoComplete="off"
        disabled={fixed}
        error={problemOf('digits')}
        onChange={(event) => {
          set('digits', event.target.value.replace(/\D/g, ''));
        }}
      />
      <p className="settings-row__value" aria-live="polite">
        {example === undefined ? null : t('tax.seriesDialog.example', { example })}
      </p>
      <ReasonField reason={reason} submitted={submitted} onChange={setReason} />
    </FormDialog>
  );
}
