import type { ItemAvailabilityRequest, ItemView } from '@rp/contracts';
import { Button, ChoiceGroup, Dialog, IconButton, Icon, Select, TextField } from '@rp/ui-web';
import { useId, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { PhotoPicker } from '../PhotoPicker.js';
import { ComboFields } from './ComboFields.js';
import type { MenuData } from './MenuEditor.js';
import {
  categoryRows,
  changesPrice,
  checkCombo,
  checkItem,
  type ComboForm,
  comboFormOf,
  comboRequestOf,
  FOOD_TYPES,
  type ItemField,
  type ItemForm,
  itemFormOf,
  itemRequestOf,
  newKey,
  nextOrder,
  SALES_CHANNELS,
  SPICE_LEVELS,
} from './menu-view.js';

/**
 * Adds or edits a dish (MENU-002 to MENU-005, MENU-008, MENU-011): every attribute, a photo, sizes
 * with their own prices, the option groups it offers, and whether it is a combo of other dishes.
 * The form checks what the server checks before sending; the server checks again.
 */
export function ItemDialog({
  data,
  item,
  defaultCategoryId,
  onSaved,
  onClose,
}: {
  data: MenuData;
  item: ItemView | undefined;
  defaultCategoryId: string;
  onSaved: (name: string, added: boolean) => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const formId = useId();
  const { draft } = data;
  const activeTaxGroups = data.taxGroups.filter((group) => group.archivedAt === null);
  const activeStations = data.stations.filter((station) => station.archivedAt === null);
  const existingCombo =
    item === undefined ? undefined : draft.combos.find((c) => c.itemId === item.id);
  const [form, setForm] = useState<ItemForm>(() =>
    itemFormOf(item, {
      categoryId: defaultCategoryId,
      taxGroupId: activeTaxGroups.length === 1 ? (activeTaxGroups[0]?.id ?? '') : '',
      stationId: activeStations.length === 1 ? (activeStations[0]?.id ?? '') : '',
      displayOrder: nextOrder(draft.items.map((entry) => entry.displayOrder)),
    }),
  );
  const [isCombo, setIsCombo] = useState(existingCombo !== undefined);
  const [combo, setCombo] = useState<ComboForm>(() => comboFormOf(existingCombo));
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const problems = checkItem(form);
  const comboProblems = isCombo ? checkCombo(combo) : {};
  const problemOf = (field: ItemField) => {
    const problem = problems[field];
    return submitted && problem !== undefined
      ? t(`menuEditor.item.problems.${problem}`)
      : undefined;
  };
  const set = <K extends keyof ItemForm>(key: K, value: ItemForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    setSubmitted(true);
    if (Object.keys(problems).length > 0 || Object.keys(comboProblems).length > 0) return;
    setError(undefined);
    setBusy(true);
    try {
      const body = itemRequestOf(form);
      const saved =
        item === undefined
          ? await controller.api.createItem({ body })
          : await controller.api.updateItem({ params: { id: item.id }, body });
      if (isCombo) {
        await controller.api.setCombo({ params: { id: saved.id }, body: comboRequestOf(combo) });
      }
      onSaved(saved.name, item === undefined);
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  const activeGroups = draft.modifierGroups.filter((group) => group.archivedAt === null);
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      dismissible={!busy && !uploading}
      title={
        item === undefined
          ? t('menuEditor.item.addTitle')
          : t('menuEditor.item.editTitle', { name: item.name })
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('menuEditor.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy} disabled={uploading}>
            {item === undefined ? t('menuEditor.item.add') : t('menuEditor.item.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="console-form menu-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="menu-form__section">
          <legend>{t('menuEditor.item.sectionBasics')}</legend>
          <TextField
            label={t('menuEditor.item.name')}
            value={form.name}
            maxLength={80}
            autoComplete="off"
            required
            data-autofocus
            error={problemOf('name')}
            onChange={(event) => {
              set('name', event.target.value);
            }}
          />
          <Select
            label={t('menuEditor.item.category')}
            value={form.categoryId}
            required
            error={problemOf('categoryId')}
            options={[
              { value: '', label: t('menuEditor.item.chooseCategory') },
              ...categoryRows(draft.categories).map(({ category, depth }) => ({
                value: category.id,
                label: depth === 0 ? category.name : `— ${category.name}`,
              })),
            ]}
            onChange={(event) => {
              set('categoryId', event.target.value);
            }}
          />
          <TextField
            label={t('menuEditor.item.description')}
            value={form.description}
            maxLength={500}
            autoComplete="off"
            error={problemOf('description')}
            onChange={(event) => {
              set('description', event.target.value);
            }}
          />
          <PhotoPicker
            photoId={form.photoId}
            onChange={(photoId) => {
              set('photoId', photoId);
            }}
            onUploading={setUploading}
            onError={setError}
            label={t('menuEditor.item.photo')}
            hint={t('menuEditor.item.photoHint')}
            alt={t('menuEditor.item.photoAlt', { name: form.name })}
            uploadLabel={t('menuEditor.item.uploadPhoto')}
            replaceLabel={t('menuEditor.item.replacePhoto')}
            removeLabel={t('menuEditor.item.removePhoto')}
            tooLarge={t('menuEditor.item.photoTooLarge')}
          />
          <ChoiceGroup
            legend={t('menuEditor.item.foodType')}
            mode="single"
            options={FOOD_TYPES.map((type) => ({
              id: type,
              label: t(`pos.menu.foodType.${type}`),
            }))}
            value={[form.foodType]}
            onChange={([type]) => {
              if (type !== undefined) set('foodType', type as ItemForm['foodType']);
            }}
          />
          <ChoiceGroup
            legend={t('menuEditor.item.spiceLevel')}
            mode="single"
            options={SPICE_LEVELS.map((name, level) => ({
              id: String(level),
              label: t(`menuEditor.item.spice.${name}`),
            }))}
            value={[String(form.spiceLevel)]}
            onChange={([level]) => {
              if (level !== undefined) set('spiceLevel', Number(level));
            }}
          />
        </fieldset>

        <fieldset className="menu-form__section">
          <legend>{t('menuEditor.item.sectionPrice')}</legend>
          <TextField
            label={t('menuEditor.item.price')}
            hint={t('menuEditor.item.priceHint')}
            value={form.basePrice}
            inputMode="decimal"
            autoComplete="off"
            required
            error={problemOf('basePrice')}
            onChange={(event) => {
              set('basePrice', event.target.value);
            }}
          />
          <Select
            label={t('menuEditor.item.taxGroup')}
            value={form.taxGroupId}
            required
            error={problemOf('taxGroupId')}
            options={[
              { value: '', label: t('menuEditor.item.chooseTaxGroup') },
              ...activeTaxGroups.map((group) => ({ value: group.id, label: group.name })),
            ]}
            onChange={(event) => {
              set('taxGroupId', event.target.value);
            }}
          />
          {changesPrice(item, form) ? (
            <TextField
              label={t('menuEditor.item.reason')}
              hint={t('menuEditor.item.reasonHint')}
              value={form.reason}
              maxLength={200}
              autoComplete="off"
              onChange={(event) => {
                set('reason', event.target.value);
              }}
            />
          ) : null}
          <ChoiceGroup
            legend={t('menuEditor.item.channels')}
            mode="multiple"
            options={SALES_CHANNELS.map((channel) => ({
              id: channel,
              label: t(`menuEditor.item.channel.${channel}`),
            }))}
            value={[...form.channels]}
            error={problemOf('channels')}
            onChange={(channels) => {
              set('channels', channels as ItemForm['channels']);
            }}
          />
        </fieldset>

        <fieldset className="menu-form__section">
          <legend>{t('menuEditor.item.sectionKitchen')}</legend>
          <Select
            label={t('menuEditor.item.station')}
            value={form.stationId}
            required
            error={problemOf('stationId')}
            options={[
              { value: '', label: t('menuEditor.item.chooseStation') },
              ...activeStations.map((station) => ({ value: station.id, label: station.name })),
            ]}
            onChange={(event) => {
              set('stationId', event.target.value);
            }}
          />
          <TextField
            label={t('menuEditor.item.prepTime')}
            hint={t('menuEditor.item.prepTimeHint')}
            value={form.prepTime}
            inputMode="numeric"
            autoComplete="off"
            error={problemOf('prepTime')}
            onChange={(event) => {
              set('prepTime', event.target.value);
            }}
          />
          <p className="menu-form__hint">{t('menuEditor.item.hoursHint')}</p>
          <div className="menu-form__row">
            <TextField
              label={t('menuEditor.item.servedFrom')}
              type="time"
              value={form.servedFrom}
              onChange={(event) => {
                set('servedFrom', event.target.value);
              }}
            />
            <TextField
              label={t('menuEditor.item.servedUntil')}
              type="time"
              value={form.servedUntil}
              error={problemOf('hours')}
              onChange={(event) => {
                set('servedUntil', event.target.value);
              }}
            />
          </div>
          <TextField
            label={t('menuEditor.item.shortCode')}
            hint={t('menuEditor.item.shortCodeHint')}
            value={form.shortCode}
            maxLength={12}
            autoComplete="off"
            error={problemOf('shortCode')}
            onChange={(event) => {
              set('shortCode', event.target.value);
            }}
          />
          <TextField
            label={t('menuEditor.order')}
            hint={t('menuEditor.orderHint')}
            value={form.displayOrder}
            inputMode="numeric"
            autoComplete="off"
            error={problemOf('displayOrder')}
            onChange={(event) => {
              set('displayOrder', event.target.value);
            }}
          />
        </fieldset>

        <fieldset className="menu-form__section">
          <legend>{t('menuEditor.item.sectionOptions')}</legend>
          <p className="menu-form__hint">{t('menuEditor.item.variantsHint')}</p>
          {form.variants.map((variant, index) => (
            <div className="menu-form__row" key={variant.key}>
              <TextField
                label={t('menuEditor.item.variantName')}
                value={variant.name}
                maxLength={40}
                autoComplete="off"
                onChange={(event) => {
                  const variants = [...form.variants];
                  variants[index] = { ...variant, name: event.target.value };
                  set('variants', variants);
                }}
              />
              <TextField
                label={t('menuEditor.item.variantPrice')}
                value={variant.price}
                inputMode="decimal"
                autoComplete="off"
                onChange={(event) => {
                  const variants = [...form.variants];
                  variants[index] = { ...variant, price: event.target.value };
                  set('variants', variants);
                }}
              />
              <IconButton
                label={t('menuEditor.item.removeVariant', {
                  name: variant.name === '' ? String(index + 1) : variant.name,
                })}
                icon={<Icon name="close" />}
                onClick={() => {
                  set(
                    'variants',
                    form.variants.filter((entry) => entry.key !== variant.key),
                  );
                }}
              />
            </div>
          ))}
          {problemOf('variants') === undefined ? null : (
            <p role="alert" className="menu-form__error">
              {problemOf('variants')}
            </p>
          )}
          {form.variants.length >= 10 ? null : (
            <Button
              variant="secondary"
              startIcon={<Icon name="plus" />}
              onClick={() => {
                set('variants', [...form.variants, { key: newKey(), name: '', price: '' }]);
              }}
            >
              {t('menuEditor.item.addVariant')}
            </Button>
          )}
          {activeGroups.length === 0 ? (
            <p className="menu-form__hint">{t('menuEditor.item.noGroups')}</p>
          ) : (
            <ChoiceGroup
              legend={t('menuEditor.item.groups')}
              hint={t('menuEditor.item.groupsHint')}
              mode="multiple"
              max={10}
              options={activeGroups.map((group) => ({ id: group.id, label: group.name }))}
              value={[...form.modifierGroupIds]}
              onChange={(ids) => {
                set('modifierGroupIds', ids);
              }}
            />
          )}
        </fieldset>

        <fieldset className="menu-form__section">
          <legend>{t('menuEditor.item.sectionMore')}</legend>
          <TextField
            label={t('menuEditor.item.tags')}
            hint={t('menuEditor.item.tagsHint')}
            value={form.tags}
            autoComplete="off"
            error={problemOf('tags')}
            onChange={(event) => {
              set('tags', event.target.value);
            }}
          />
          <TextField
            label={t('menuEditor.item.synonyms')}
            hint={t('menuEditor.item.synonymsHint')}
            value={form.synonyms}
            autoComplete="off"
            error={problemOf('synonyms')}
            onChange={(event) => {
              set('synonyms', event.target.value);
            }}
          />
          <label className="menu-toolbar__check">
            <input
              type="checkbox"
              checked={form.repeatable}
              onChange={(event) => {
                set('repeatable', event.target.checked);
              }}
            />
            {t('menuEditor.item.repeatable')}
          </label>
          <TextField
            label={t('menuEditor.item.externalId')}
            hint={t('menuEditor.item.externalIdHint')}
            value={form.externalId}
            maxLength={128}
            autoComplete="off"
            onChange={(event) => {
              set('externalId', event.target.value);
            }}
          />
        </fieldset>

        <fieldset className="menu-form__section">
          <legend>{t('menuEditor.item.sectionCombo')}</legend>
          <label className="menu-toolbar__check">
            <input
              type="checkbox"
              checked={isCombo}
              // A combo stays a combo; archive the dish to stop selling it.
              disabled={existingCombo !== undefined}
              onChange={(event) => {
                setIsCombo(event.target.checked);
              }}
            />
            {t('menuEditor.item.isCombo')}
          </label>
          {isCombo ? (
            <>
              <p className="menu-form__hint">{t('menuEditor.item.comboHint')}</p>
              <ComboFields
                draft={draft}
                comboItemId={item?.id}
                form={combo}
                problems={submitted ? comboProblems : {}}
                onChange={setCombo}
              />
            </>
          ) : null}
        </fieldset>

        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** Available or out of stock, and the portions left when they are counted (MENU-006). */
export function AvailabilityDialog({
  item,
  busy,
  error,
  onSave,
  onClose,
}: {
  item: ItemView;
  busy: boolean;
  error: string | undefined;
  onSave: (body: ItemAvailabilityRequest) => void;
  onClose: () => void;
}) {
  const t = useT();
  const formId = useId();
  const [available, setAvailable] = useState(item.available);
  const [counting, setCounting] = useState(item.stockCount !== null);
  const [left, setLeft] = useState(item.stockCount === null ? '' : String(item.stockCount));
  const [submitted, setSubmitted] = useState(false);
  const leftOk = !counting || (/^\d{1,6}$/.test(left.trim()) && Number(left.trim()) <= 100_000);
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={t('menuEditor.availability.title', { name: item.name })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('menuEditor.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('menuEditor.availability.save')}
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
          setSubmitted(true);
          if (!leftOk) return;
          onSave({ available, stockCount: counting ? Number(left.trim()) : null });
        }}
      >
        <p className="dashboard-section__hint">{t('menuEditor.availability.description')}</p>
        <label className="menu-toolbar__check">
          <input
            type="checkbox"
            checked={available}
            data-autofocus
            onChange={(event) => {
              setAvailable(event.target.checked);
            }}
          />
          {t('menuEditor.availability.available')}
        </label>
        <label className="menu-toolbar__check">
          <input
            type="checkbox"
            checked={counting}
            onChange={(event) => {
              setCounting(event.target.checked);
            }}
          />
          {t('menuEditor.availability.count')}
        </label>
        {counting ? (
          <TextField
            label={t('menuEditor.availability.left')}
            hint={t('menuEditor.availability.countHint')}
            value={left}
            inputMode="numeric"
            autoComplete="off"
            error={submitted && !leftOk ? t('menuEditor.availability.leftInvalid') : undefined}
            onChange={(event) => {
              setLeft(event.target.value);
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
