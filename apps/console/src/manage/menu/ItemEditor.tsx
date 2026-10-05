import type { ItemView } from '@rp/contracts';
import { ruleOf } from '@rp/ordering';
import {
  Button,
  ChoiceGroup,
  EmptyState,
  Icon,
  IconButton,
  Select,
  TextArea,
  TextField,
  useToast,
} from '@rp/ui-web';
import { type ReactNode, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { ComboSection } from './ComboSection.js';
import { type MenuData, useMenu } from './MenuArea.js';
import {
  categoryChoices,
  checkCombo,
  checkItem,
  type ComboForm,
  comboChanged,
  comboFormOf,
  comboItemChoices,
  comboPartIds,
  comboRequestOf,
  emptyItemForm,
  emptySize,
  FOOD_TYPES,
  groupChoices,
  type ItemForm,
  itemChanged,
  itemFormOf,
  itemRequestOf,
  photoBase64,
  pricesChange,
  SALES_CHANNELS,
  type SizeForm,
  SPICE_LABELS,
  SPICE_LEVELS,
} from './menu-view.js';

const BACK = '/manage/menu';

/**
 * Adds or edits one item (P4-02d, MENU-002 to MENU-005, MENU-008, MENU-009, MENU-011) on its own
 * page: `/manage/menu/items/new` or `/manage/menu/items/:itemId`.
 */
export function ItemEditor() {
  const t = useT();
  const navigate = useNavigate();
  const { itemId } = useParams();
  const { menu } = useMenu();
  // A new item saved without its combo stays here as that item, so saving again updates it.
  const [created, setCreated] = useState<ItemView | undefined>();
  const id = itemId ?? created?.id;
  const item =
    id === undefined ? undefined : (menu.draft.items.find((entry) => entry.id === id) ?? created);

  const back = (
    <Button
      variant="ghost"
      onClick={() => {
        void navigate(BACK);
      }}
    >
      {t('menuEditor.editor.back')}
    </Button>
  );
  if (itemId !== undefined && item === undefined) {
    return (
      <section className="dashboard-section" aria-label={t('menuEditor.items.title')}>
        <EmptyState title={t('menuEditor.editor.notFound')} />
        <div>{back}</div>
      </section>
    );
  }
  if (item !== undefined && item.archivedAt !== null) {
    return (
      <section className="dashboard-section" aria-labelledby="menu-item-editor">
        <div className="staff-header">
          <h2 id="menu-item-editor" className="dashboard-section__heading">
            {t('menuEditor.editor.editTitle', { name: item.name })}
          </h2>
          {back}
        </div>
        <p className="console-notice">{t('menuEditor.editor.archivedNotice')}</p>
      </section>
    );
  }
  return <ItemEditorForm key={itemId ?? 'new'} item={item} back={back} onCreated={setCreated} />;
}

/** The one active choice, if there is exactly one: a new item starts with it. */
function onlyOne(
  entries: readonly { id: string; archivedAt: string | null }[],
): string | undefined {
  const active = entries.filter((entry) => entry.archivedAt === null);
  return active.length === 1 ? active[0]?.id : undefined;
}

function newItemForm(menu: MenuData): ItemForm {
  const categories = categoryChoices(menu.draft.categories).map((choice) => choice.category);
  return emptyItemForm({
    ...(onlyOne(categories) !== undefined && { categoryId: onlyOne(categories) }),
    ...(onlyOne(menu.taxGroups) !== undefined && { taxGroupId: onlyOne(menu.taxGroups) }),
    ...(onlyOne(menu.stations) !== undefined && { stationId: onlyOne(menu.stations) }),
  });
}

function ItemEditorForm({
  item,
  back,
  onCreated,
}: {
  /** Undefined to add an item. */
  item: ItemView | undefined;
  back: ReactNode;
  onCreated: (item: ItemView) => void;
}) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const navigate = useNavigate();
  const { menu, reload } = useMenu();
  const { draft } = menu;
  const formRef = useRef<HTMLFormElement>(null);
  const existingCombo =
    item === undefined ? undefined : draft.combos.find((combo) => combo.itemId === item.id);
  const [form, setForm] = useState<ItemForm>(() =>
    item === undefined ? newItemForm(menu) : itemFormOf(item),
  );
  const [combo, setCombo] = useState<ComboForm>(() => comboFormOf(existingCombo));
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);
  const [photoError, setPhotoError] = useState<string | undefined>();
  const fileRef = useRef<HTMLInputElement>(null);

  const problems = checkItem(form);
  const comboProblems = checkCombo(combo);
  const invalid = Object.keys(problems).length > 0 || Object.keys(comboProblems).length > 0;
  const problemOf = (field: string): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? t(`menuEditor.editor.${problem}`) : undefined;
  };
  const set = <K extends keyof ItemForm>(field: K, value: ItemForm[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
  };
  const setSize = (key: string, change: Partial<SizeForm>) => {
    setForm((current) => ({
      ...current,
      sizes: current.sizes.map((size) => (size.key === key ? { ...size, ...change } : size)),
    }));
  };
  const askReason = item !== undefined && pricesChange(item, form);

  const nameOf = (itemId: string): string => {
    const found = draft.items.find((entry) => entry.id === itemId);
    if (found === undefined) return itemId;
    return found.archivedAt === null
      ? found.name
      : t('menuEditor.archivedChoice', { name: found.name });
  };
  const choiceOf = (entry: { id: string; name: string; archivedAt: string | null }) => ({
    value: entry.id,
    label:
      entry.archivedAt === null ? entry.name : t('menuEditor.archivedChoice', { name: entry.name }),
  });
  /** Active entries, and the one the item names now even if it was archived since. */
  const offered = <T extends { id: string; archivedAt: string | null }>(
    entries: readonly T[],
    current: string,
  ) => entries.filter((entry) => entry.archivedAt === null || entry.id === current);

  const upload = async (file: File) => {
    setPhotoError(undefined);
    const content = await photoBase64(file);
    if (!content.ok) {
      setPhotoError(t('menuEditor.editor.photoTooLarge'));
      return;
    }
    setUploading(true);
    try {
      const photo = await controller.api.uploadPhoto({ body: { contentBase64: content.base64 } });
      set('photoId', photo.id);
    } catch (failure) {
      setPhotoError(messageOf(failure, t));
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    setSubmitted(true);
    if (invalid) {
      // The first field that needs a change, after React has marked it.
      setTimeout(() => {
        formRef.current
          ?.querySelector<HTMLElement>(
            'input[aria-invalid="true"], select[aria-invalid="true"], textarea[aria-invalid="true"], fieldset[aria-invalid="true"] input',
          )
          ?.focus();
      });
      return;
    }
    setBusy(true);
    setError(undefined);
    const request = itemRequestOf(form, draft.items);
    let saved: ItemView;
    try {
      if (item === undefined) {
        saved = await controller.api.createItem({ body: request });
      } else if (itemChanged(item, request)) {
        saved = await controller.api.updateItem({ params: { id: item.id }, body: request });
      } else {
        saved = item;
      }
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
      return;
    }
    const setsCombo = comboChanged(combo, existingCombo);
    if (setsCombo) {
      try {
        await controller.api.setCombo({ params: { id: saved.id }, body: comboRequestOf(combo) });
      } catch (failure) {
        if (item === undefined) onCreated(saved);
        reload();
        setError(t('menuEditor.combo.savedItemOnly', { message: messageOf(failure, t) }));
        setBusy(false);
        return;
      }
    }
    if (saved !== item || setsCombo) {
      toast.show({ title: t('menuEditor.editor.saved', { name: saved.name }), tone: 'success' });
      reload();
    }
    void navigate(BACK);
  };

  const categories = categoryChoices(draft.categories);
  const groups = groupChoices(draft.modifierGroups, form.modifierGroupIds);
  const parts = comboPartIds(draft.combos);
  const hasSizes = form.sizes.length > 0;

  return (
    <section className="dashboard-section menu-editor" aria-labelledby="menu-item-editor">
      <div className="staff-header">
        <h2 id="menu-item-editor" className="dashboard-section__heading">
          {item === undefined
            ? t('menuEditor.editor.newTitle')
            : t('menuEditor.editor.editTitle', { name: item.name })}
        </h2>
        {back}
      </div>
      {submitted && invalid ? (
        <p role="alert" className="console-notice console-notice--danger">
          {t('menuEditor.editor.problems')}
        </p>
      ) : null}
      <form
        ref={formRef}
        className="console-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="menu-editor__section">
          <legend className="menu-editor__legend">{t('menuEditor.editor.basics')}</legend>
          <TextField
            label={t('menuEditor.editor.name')}
            value={form.name}
            maxLength={80}
            autoComplete="off"
            required
            error={problemOf('name')}
            onChange={(event) => {
              set('name', event.target.value);
            }}
          />
          <Select
            label={t('menuEditor.editor.category')}
            placeholder={t('menuEditor.editor.chooseCategory')}
            value={form.categoryId}
            required
            hint={categories.length === 0 ? t('menuEditor.editor.noCategories') : undefined}
            options={categories.map(({ category, parent }) => ({
              value: category.id,
              label:
                parent === null
                  ? category.name
                  : t('menuEditor.categoryPath', { parent: parent.name, name: category.name }),
            }))}
            error={problemOf('categoryId')}
            onChange={(event) => {
              set('categoryId', event.target.value);
            }}
          />
          <TextField
            label={t('menuEditor.editor.shortCode')}
            hint={t('menuEditor.editor.shortCodeHint')}
            value={form.shortCode}
            maxLength={12}
            autoComplete="off"
            className="menu-editor__short"
            error={problemOf('shortCode')}
            onChange={(event) => {
              set('shortCode', event.target.value);
            }}
          />
          <TextArea
            label={t('menuEditor.editor.description')}
            value={form.description}
            maxLength={500}
            error={problemOf('description')}
            onChange={(event) => {
              set('description', event.target.value);
            }}
          />
          <ChoiceGroup
            legend={t('menuEditor.editor.foodType')}
            mode="single"
            options={FOOD_TYPES.map((type) => ({
              id: type,
              label: t(`pos.menu.foodType.${type}`),
            }))}
            value={form.foodType === '' ? [] : [form.foodType]}
            error={problemOf('foodType')}
            onChange={([type]) => {
              const chosen = FOOD_TYPES.find((candidate) => candidate === type);
              if (chosen !== undefined) set('foodType', chosen);
            }}
          />
          <ChoiceGroup
            legend={t('menuEditor.editor.spiceLevel')}
            mode="single"
            options={SPICE_LEVELS.map((level) => ({
              id: String(level),
              label: t(SPICE_LABELS[level]),
            }))}
            value={[String(form.spiceLevel)]}
            onChange={([level]) => {
              set('spiceLevel', Number(level));
            }}
          />
        </fieldset>

        <fieldset className="menu-editor__section">
          <legend className="menu-editor__legend">{t('menuEditor.editor.photo')}</legend>
          <div className="menu-photo">
            {form.photoId === null ? (
              <p className="menu-photo__none">{t('menuEditor.editor.noPhoto')}</p>
            ) : (
              <img
                className="menu-photo__image"
                src={controller.photoSrc(form.photoId, 480)}
                alt={t('menuEditor.editor.photoAlt', { name: form.name.trim() || '…' })}
              />
            )}
            <div className="menu-photo__actions">
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif"
                hidden
                aria-label={t('menuEditor.editor.photo')}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file !== undefined) void upload(file);
                }}
              />
              <Button
                variant="secondary"
                loading={uploading}
                onClick={() => {
                  fileRef.current?.click();
                }}
              >
                {form.photoId === null
                  ? t('menuEditor.editor.choosePhoto')
                  : t('menuEditor.editor.replacePhoto')}
              </Button>
              {form.photoId === null ? null : (
                <Button
                  variant="ghost"
                  disabled={uploading}
                  onClick={() => {
                    set('photoId', null);
                  }}
                >
                  {t('menuEditor.editor.removePhoto')}
                </Button>
              )}
            </div>
            <p className="rp-field__hint" aria-live="polite">
              {uploading ? t('menuEditor.editor.uploading') : t('menuEditor.editor.photoHint')}
            </p>
            {photoError === undefined ? null : (
              <p role="alert" className="rp-field__error">
                {photoError}
              </p>
            )}
          </div>
        </fieldset>

        <fieldset className="menu-editor__section">
          <legend className="menu-editor__legend">{t('menuEditor.editor.priceAndTax')}</legend>
          <div className="menu-editor__row">
            <TextField
              label={t(
                hasSizes ? 'menuEditor.editor.basePriceWithSizes' : 'menuEditor.editor.basePrice',
              )}
              inputMode="decimal"
              autoComplete="off"
              value={form.basePrice}
              required
              error={problemOf('basePrice')}
              onChange={(event) => {
                set('basePrice', event.target.value);
              }}
            />
            <Select
              label={t('menuEditor.editor.taxGroup')}
              placeholder={t('menuEditor.editor.chooseTaxGroup')}
              value={form.taxGroupId}
              required
              options={offered(menu.taxGroups, form.taxGroupId).map(choiceOf)}
              error={problemOf('taxGroupId')}
              onChange={(event) => {
                set('taxGroupId', event.target.value);
              }}
            />
          </div>
        </fieldset>

        <fieldset className="menu-editor__section">
          <legend className="menu-editor__legend">{t('menuEditor.editor.sizes')}</legend>
          <p className="rp-field__hint">{t('menuEditor.editor.sizesHint')}</p>
          {form.sizes.map((size, index) => (
            <div key={size.key} className="menu-editor__row menu-editor__row--removable">
              <TextField
                label={t('menuEditor.editor.sizeName', { number: index + 1 })}
                value={size.name}
                maxLength={40}
                autoComplete="off"
                error={problemOf(`size:${size.key}:name`)}
                onChange={(event) => {
                  setSize(size.key, { name: event.target.value });
                }}
              />
              <TextField
                label={t('menuEditor.editor.sizePrice', { number: index + 1 })}
                inputMode="decimal"
                autoComplete="off"
                value={size.price}
                error={problemOf(`size:${size.key}:price`)}
                onChange={(event) => {
                  setSize(size.key, { price: event.target.value });
                }}
              />
              <IconButton
                label={t('menuEditor.editor.removeSize', { number: index + 1 })}
                icon={<Icon name="close" />}
                onClick={() => {
                  setForm((current) => ({
                    ...current,
                    sizes: current.sizes.filter((other) => other.key !== size.key),
                  }));
                }}
              />
            </div>
          ))}
          {form.sizes.length < 10 ? (
            <div>
              <Button
                variant="secondary"
                startIcon={<Icon name="plus" />}
                onClick={() => {
                  setForm((current) => ({ ...current, sizes: [...current.sizes, emptySize()] }));
                }}
              >
                {t('menuEditor.editor.addSize')}
              </Button>
            </div>
          ) : null}
        </fieldset>

        {groups.length === 0 ? (
          <fieldset className="menu-editor__section">
            <legend className="menu-editor__legend">{t('menuEditor.editor.modifierGroups')}</legend>
            <p className="rp-field__hint">{t('menuEditor.editor.noModifierGroups')}</p>
          </fieldset>
        ) : (
          <ChoiceGroup
            className="menu-editor__section"
            legend={t('menuEditor.editor.modifierGroups')}
            hint={t('menuEditor.editor.modifierGroupsHint')}
            mode="multiple"
            max={10}
            options={groups.map((group) => ({
              id: group.id,
              label:
                group.archivedAt === null
                  ? group.name
                  : t('menuEditor.archivedChoice', { name: group.name }),
              detail: ruleOf(group, t),
            }))}
            value={form.modifierGroupIds}
            onChange={(ids) => {
              set('modifierGroupIds', ids);
            }}
          />
        )}

        <fieldset className="menu-editor__section">
          <legend className="menu-editor__legend">{t('menuEditor.editor.kitchen')}</legend>
          <div className="menu-editor__row">
            <Select
              label={t('menuEditor.editor.station')}
              placeholder={t('menuEditor.editor.chooseStation')}
              value={form.stationId}
              required
              options={offered(menu.stations, form.stationId).map(choiceOf)}
              error={problemOf('stationId')}
              onChange={(event) => {
                set('stationId', event.target.value);
              }}
            />
            <TextField
              label={t('menuEditor.editor.prepTime')}
              hint={t('menuEditor.editor.prepTimeHint')}
              inputMode="numeric"
              autoComplete="off"
              value={form.prepTime}
              maxLength={3}
              error={problemOf('prepTime')}
              onChange={(event) => {
                set('prepTime', event.target.value);
              }}
            />
          </div>
        </fieldset>

        <ChoiceGroup
          className="menu-editor__section"
          legend={t('menuEditor.editor.channels')}
          mode="multiple"
          options={SALES_CHANNELS.map((channel) => ({
            id: channel,
            label: t(`menuEditor.editor.channel.${channel}`),
          }))}
          value={form.channels}
          error={problemOf('channels')}
          onChange={(ids) => {
            set(
              'channels',
              SALES_CHANNELS.filter((channel) => ids.includes(channel)),
            );
          }}
        />

        <fieldset className="menu-editor__section">
          <legend className="menu-editor__legend">{t('menuEditor.editor.labels')}</legend>
          <TextField
            label={t('menuEditor.editor.tags')}
            hint={t('menuEditor.editor.tagsHint')}
            value={form.tags}
            autoComplete="off"
            error={problemOf('tags')}
            onChange={(event) => {
              set('tags', event.target.value);
            }}
          />
          <TextField
            label={t('menuEditor.editor.synonyms')}
            hint={t('menuEditor.editor.synonymsHint')}
            value={form.synonyms}
            autoComplete="off"
            error={problemOf('synonyms')}
            onChange={(event) => {
              set('synonyms', event.target.value);
            }}
          />
        </fieldset>

        <ComboSection
          form={combo}
          problems={comboProblems}
          submitted={submitted}
          choices={comboItemChoices(draft, item?.id)}
          nameOf={nameOf}
          wasCombo={existingCombo !== undefined}
          partOfCombo={item !== undefined && parts.has(item.id)}
          onChange={setCombo}
        />

        <fieldset className="menu-editor__section">
          <legend className="menu-editor__legend">{t('menuEditor.editor.more')}</legend>
          <TextField
            label={t('menuEditor.editor.displayOrder')}
            hint={t('menuEditor.editor.displayOrderHint')}
            inputMode="numeric"
            autoComplete="off"
            value={form.displayOrder}
            maxLength={4}
            className="menu-editor__short"
            error={problemOf('displayOrder')}
            onChange={(event) => {
              set('displayOrder', event.target.value);
            }}
          />
          <label className="console-check">
            <input
              type="checkbox"
              checked={form.repeatable}
              onChange={(event) => {
                set('repeatable', event.target.checked);
              }}
            />
            {t('menuEditor.editor.repeatable')}
          </label>
          <TextField
            label={t('menuEditor.editor.externalId')}
            hint={t('menuEditor.editor.externalIdHint')}
            value={form.externalId}
            maxLength={128}
            autoComplete="off"
            error={problemOf('externalId')}
            onChange={(event) => {
              set('externalId', event.target.value);
            }}
          />
        </fieldset>

        {askReason ? (
          <TextField
            label={t('menuEditor.editor.reason')}
            value={form.reason}
            maxLength={200}
            autoComplete="off"
            error={problemOf('reason')}
            onChange={(event) => {
              set('reason', event.target.value);
            }}
          />
        ) : null}
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
        <div className="menu-editor__actions">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              void navigate(BACK);
            }}
          >
            {t('menuEditor.editor.cancel')}
          </Button>
          <Button type="submit" loading={busy} disabled={uploading}>
            {t('menuEditor.editor.save')}
          </Button>
        </div>
      </form>
    </section>
  );
}
