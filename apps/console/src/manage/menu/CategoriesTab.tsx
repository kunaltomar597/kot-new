import type { CategoryView } from '@rp/contracts';
import { Badge, Button, Dialog, EmptyState, Icon, Select, TextField, useToast } from '@rp/ui-web';
import { useCallback, useId, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import type { MenuTabProps } from './MenuEditor.js';
import {
  type CategoryForm,
  categoryFormOf,
  categoryRequestOf,
  categoryRows,
  checkCategory,
  nextOrder,
  parentChoices,
} from './menu-view.js';
import { ReasonDialog } from './ReasonDialog.js';

type Open =
  { readonly kind: 'ADD' } | { readonly kind: 'EDIT' | 'ARCHIVE'; readonly category: CategoryView };

/** Categories with one level of sub-categories (MENU-001), in menu order. */
export function CategoriesTab({ data, reload }: MenuTabProps) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const [archived, setArchived] = useState(false);
  const [open, setOpen] = useState<Open | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const { categories, items } = data.draft;
  const rows = categoryRows(categories, { archived });
  const dishes = (id: string) =>
    items.filter((item) => item.categoryId === id && item.archivedAt === null).length;

  const close = useCallback(() => {
    setOpen(undefined);
    setBusy(false);
    setError(undefined);
  }, []);

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      toast.show({ title: done, tone: 'success' });
      close();
      reload();
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  return (
    <div className="menu-tab">
      <div className="menu-toolbar">
        <label className="menu-toolbar__check">
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => {
              setArchived(event.target.checked);
            }}
          />
          {t('menuEditor.categories.showArchived')}
        </label>
        <Button
          startIcon={<Icon name="plus" />}
          onClick={() => {
            setOpen({ kind: 'ADD' });
          }}
        >
          {t('menuEditor.categories.add')}
        </Button>
      </div>
      {error !== undefined && open === undefined ? (
        <p role="alert" className="console-notice console-notice--danger">
          {error}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState title={t('menuEditor.categories.none')} />
      ) : (
        <ul className="staff-list" aria-label={t('menuEditor.tabs.categories')}>
          {rows.map(({ category, depth }) => {
            const isArchived = category.archivedAt !== null;
            return (
              <li
                key={category.id}
                className="staff-row"
                data-depth={depth}
                data-inactive={isArchived ? '' : undefined}
              >
                <div className="staff-row__who">
                  <h3 className="staff-row__name">{category.name}</h3>
                  <p className="staff-row__role">
                    {t('menuEditor.categories.dishes', { count: dishes(category.id) })}
                  </p>
                  {isArchived ? (
                    <p className="staff-row__states">
                      <Badge tone="neutral" icon={<Icon name="ban" />}>
                        {t('menuEditor.archived')}
                      </Badge>
                    </p>
                  ) : null}
                </div>
                <div
                  className="staff-row__actions"
                  role="group"
                  aria-label={t('menuEditor.categories.actionsFor', { name: category.name })}
                >
                  {isArchived ? (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        void run(
                          () => controller.api.restoreCategory({ params: { id: category.id } }),
                          t('menuEditor.categories.restored', { name: category.name }),
                        );
                      }}
                    >
                      {t('menuEditor.restore')}
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setOpen({ kind: 'EDIT', category });
                        }}
                      >
                        {t('menuEditor.edit')}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setOpen({ kind: 'ARCHIVE', category });
                        }}
                      >
                        {t('menuEditor.archive')}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {open?.kind === 'ADD' || open?.kind === 'EDIT' ? (
        <CategoryDialog
          categories={categories}
          category={open.kind === 'EDIT' ? open.category : undefined}
          busy={busy}
          error={error}
          onSave={(form) => {
            const body = categoryRequestOf(form);
            void run(
              () =>
                open.kind === 'EDIT'
                  ? controller.api.updateCategory({ params: { id: open.category.id }, body })
                  : controller.api.createCategory({ body }),
              open.kind === 'EDIT'
                ? t('menuEditor.categories.saved', { name: body.name })
                : t('menuEditor.categories.added', { name: body.name }),
            );
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'ARCHIVE' ? (
        <ReasonDialog
          title={t('menuEditor.categories.archiveTitle', { name: open.category.name })}
          description={t('menuEditor.categories.archiveDescription')}
          confirmLabel={t('menuEditor.archive')}
          busy={busy}
          error={error}
          onConfirm={(reason) => {
            void run(
              () =>
                controller.api.archiveCategory({
                  params: { id: open.category.id },
                  body: { reason },
                }),
              t('menuEditor.categories.archivedToast', { name: open.category.name }),
            );
          }}
          onCancel={close}
        />
      ) : null}
    </div>
  );
}

function CategoryDialog({
  categories,
  category,
  busy,
  error,
  onSave,
  onClose,
}: {
  categories: readonly CategoryView[];
  category: CategoryView | undefined;
  busy: boolean;
  error: string | undefined;
  onSave: (form: CategoryForm) => void;
  onClose: () => void;
}) {
  const t = useT();
  const formId = useId();
  const [form, setForm] = useState<CategoryForm>(() =>
    categoryFormOf(category, nextOrder(categories.map((entry) => entry.displayOrder))),
  );
  const [submitted, setSubmitted] = useState(false);
  const problems = checkCategory(form);
  const parents = parentChoices(categories, category);
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={
        category === undefined
          ? t('menuEditor.categories.addTitle')
          : t('menuEditor.categories.editTitle', { name: category.name })
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('menuEditor.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('menuEditor.save')}
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
          if (Object.keys(problems).length === 0) onSave(form);
        }}
      >
        <TextField
          label={t('menuEditor.categories.name')}
          value={form.name}
          maxLength={60}
          autoComplete="off"
          required
          data-autofocus
          error={
            submitted && problems.name !== undefined ? t('menuEditor.nameRequired') : undefined
          }
          onChange={(event) => {
            setForm((current) => ({ ...current, name: event.target.value }));
          }}
        />
        {parents.length === 0 && category?.parentId === null ? (
          <p className="menu-form__hint">{t('menuEditor.categories.noParent')}</p>
        ) : (
          <Select
            label={t('menuEditor.categories.parent')}
            hint={t('menuEditor.categories.parentHint')}
            value={form.parentId}
            options={[{ value: '', label: t('menuEditor.categories.topLevel') }, ...parents]}
            onChange={(event) => {
              setForm((current) => ({ ...current, parentId: event.target.value }));
            }}
          />
        )}
        <TextField
          label={t('menuEditor.order')}
          hint={t('menuEditor.orderHint')}
          value={form.displayOrder}
          inputMode="numeric"
          autoComplete="off"
          error={
            submitted && problems.displayOrder !== undefined
              ? t('menuEditor.orderInvalid')
              : undefined
          }
          onChange={(event) => {
            setForm((current) => ({ ...current, displayOrder: event.target.value }));
          }}
        />
        {error === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
