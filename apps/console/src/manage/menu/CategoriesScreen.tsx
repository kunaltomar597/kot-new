import type { CategoryView } from '@rp/contracts';
import { Badge, Button, Dialog, EmptyState, Icon, Select, TextField, useToast } from '@rp/ui-web';
import { useId, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { ReasonDialog } from '../../billing/ReasonDialog.js';
import { useMenu } from './MenuArea.js';
import {
  type CategoryField,
  type CategoryForm,
  categoryFormOf,
  categoryRequestOf,
  categoryTree,
  checkCategory,
  emptyCategoryForm,
  hasSubcategories,
  itemsIn,
  parentChoices,
} from './menu-view.js';

type Open =
  { readonly kind: 'ADD' } | { readonly kind: 'EDIT' | 'ARCHIVE'; readonly category: CategoryView };

/**
 * The categories (P4-02d, MENU-001): top-level ones in menu order, each with its sub-categories,
 * and how many items each holds. A category is archived only when it is empty (MENU-010); the
 * server says why when it is not.
 */
export function CategoriesScreen() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { menu, reload } = useMenu();
  const [archived, setArchived] = useState(false);
  const [open, setOpen] = useState<Open | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const close = () => {
    setOpen(undefined);
    setBusy(false);
    setError(undefined);
  };

  const archive = async (category: CategoryView, reason: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await controller.api.archiveCategory({ params: { id: category.id }, body: { reason } });
      toast.show({
        title: t('menuEditor.categories.archivedToast', { name: category.name }),
        tone: 'success',
      });
      close();
      reload();
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  const restore = async (category: CategoryView) => {
    try {
      await controller.api.restoreCategory({ params: { id: category.id } });
      toast.show({
        title: t('menuEditor.categories.restoredToast', { name: category.name }),
        tone: 'success',
      });
      reload();
    } catch (failure) {
      toast.show({ title: messageOf(failure, t), tone: 'danger' });
    }
  };

  const { categories, items } = menu.draft;
  const tree = categoryTree(categories, { archived });
  const row = (category: CategoryView, parent: CategoryView | null) => (
    <CategoryRow
      key={category.id}
      category={category}
      parent={parent}
      items={itemsIn(items, category.id)}
      onAction={(action) => {
        if (action === 'RESTORE') void restore(category);
        else setOpen({ kind: action, category });
      }}
    />
  );

  return (
    <section className="dashboard-section" aria-labelledby="menu-categories">
      <div className="staff-header">
        <h2 id="menu-categories" className="dashboard-section__heading">
          {t('menuEditor.categories.title')}
        </h2>
        <Button
          startIcon={<Icon name="plus" />}
          onClick={() => {
            setOpen({ kind: 'ADD' });
          }}
        >
          {t('menuEditor.categories.add')}
        </Button>
      </div>
      <p className="dashboard-section__hint">{t('menuEditor.categories.intro')}</p>
      <label className="console-check">
        <input
          type="checkbox"
          checked={archived}
          onChange={(event) => {
            setArchived(event.target.checked);
          }}
        />
        {t('menuEditor.categories.showArchived')}
      </label>
      {tree.length === 0 ? (
        <EmptyState title={t('menuEditor.categories.none')} />
      ) : (
        <ul className="staff-list">
          {tree.flatMap((node) => [
            row(node.category, null),
            ...node.children.map((child) => row(child, node.category)),
          ])}
        </ul>
      )}
      {open?.kind === 'ADD' || open?.kind === 'EDIT' ? (
        <CategoryDialog
          category={open.kind === 'EDIT' ? open.category : undefined}
          categories={categories}
          onSaved={(saved) => {
            toast.show({
              title: t('menuEditor.categories.saved', { name: saved.name }),
              tone: 'success',
            });
            close();
            reload();
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'ARCHIVE' ? (
        <ReasonDialog
          title={t('menuEditor.categories.archiveDialog.title', { name: open.category.name })}
          description={t('menuEditor.categories.archiveDialog.description')}
          label={t('menuEditor.categories.archiveDialog.reason')}
          confirmLabel={t('menuEditor.categories.archiveDialog.confirm')}
          tone="danger"
          busy={busy}
          error={error}
          onConfirm={(reason) => {
            void archive(open.category, reason);
          }}
          onClose={close}
        />
      ) : null}
    </section>
  );
}

type CategoryAction = 'EDIT' | 'ARCHIVE' | 'RESTORE';

const ACTION_LABELS = {
  EDIT: 'menuEditor.categories.edit',
  ARCHIVE: 'menuEditor.categories.archive',
  RESTORE: 'menuEditor.categories.restore',
} as const;

function CategoryRow({
  category,
  parent,
  items,
  onAction,
}: {
  category: CategoryView;
  parent: CategoryView | null;
  items: number;
  onAction: (action: CategoryAction) => void;
}) {
  const t = useT();
  const active = category.archivedAt === null;
  const actions: readonly CategoryAction[] = active ? ['EDIT', 'ARCHIVE'] : ['RESTORE'];
  return (
    <li
      className="staff-row"
      data-inactive={active ? undefined : true}
      data-sub={parent === null ? undefined : true}
    >
      <div className="staff-row__who">
        <h3 className="staff-row__name">
          {category.name}
          {active ? null : <Badge tone="neutral">{t('menuEditor.categories.archived')}</Badge>}
        </h3>
        {parent === null ? null : (
          <p className="staff-row__role">{t('menuEditor.categories.sub', { name: parent.name })}</p>
        )}
        <p className="staff-row__contact menu-facts">
          <span>{t('menuEditor.categories.items', { count: items })}</span>
          <span>{t('menuEditor.categories.place', { order: category.displayOrder })}</span>
        </p>
      </div>
      <div
        className="staff-row__actions"
        role="group"
        aria-label={t('menuEditor.categories.actionsFor', { name: category.name })}
      >
        {actions.map((action) => (
          <Button
            key={action}
            variant="secondary"
            onClick={() => {
              onAction(action);
            }}
          >
            {t(ACTION_LABELS[action])}
          </Button>
        ))}
      </div>
    </li>
  );
}

/** Adds a category or edits one: its name, where it goes (MENU-001) and its place. */
function CategoryDialog({
  category,
  categories,
  onSaved,
  onClose,
}: {
  /** Undefined to add one. */
  category: CategoryView | undefined;
  categories: readonly CategoryView[];
  onSaved: (saved: CategoryView) => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const formId = useId();
  const [form, setForm] = useState<CategoryForm>(() =>
    category === undefined ? emptyCategoryForm() : categoryFormOf(category),
  );
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const problems = checkCategory(form);
  const problemOf = (field: CategoryField): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined
      ? t(`menuEditor.categories.dialog.${problem}`)
      : undefined;
  };
  const parents = parentChoices(categories, category?.id);
  const keepsTop = category !== undefined && hasSubcategories(categories, category.id);

  const save = async () => {
    setSubmitted(true);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    setError(undefined);
    const body = categoryRequestOf(form, categories, category?.id);
    try {
      const saved =
        category === undefined
          ? await controller.api.createCategory({ body })
          : await controller.api.updateCategory({ params: { id: category.id }, body });
      onSaved(saved);
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
      title={
        category === undefined
          ? t('menuEditor.categories.dialog.addTitle')
          : t('menuEditor.categories.dialog.editTitle', { name: category.name })
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('menuEditor.categories.dialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('menuEditor.categories.dialog.save')}
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
        <TextField
          label={t('menuEditor.categories.dialog.name')}
          value={form.name}
          maxLength={60}
          autoComplete="off"
          required
          data-autofocus
          error={problemOf('name')}
          onChange={(event) => {
            const name = event.target.value;
            setForm((current) => ({ ...current, name }));
          }}
        />
        {keepsTop ? (
          <p className="rp-field__hint">{t('menuEditor.categories.dialog.hasSubcategories')}</p>
        ) : (
          <Select
            label={t('menuEditor.categories.dialog.parent')}
            hint={t('menuEditor.categories.dialog.parentHint')}
            value={form.parentId}
            options={[
              { value: '', label: t('menuEditor.categories.dialog.topLevel') },
              ...parents.map((parent) => ({ value: parent.id, label: parent.name })),
            ]}
            onChange={(event) => {
              const parentId = event.target.value;
              setForm((current) => ({ ...current, parentId }));
            }}
          />
        )}
        <TextField
          label={t('menuEditor.categories.dialog.displayOrder')}
          hint={t('menuEditor.categories.dialog.displayOrderHint')}
          inputMode="numeric"
          autoComplete="off"
          value={form.displayOrder}
          maxLength={4}
          error={problemOf('displayOrder')}
          onChange={(event) => {
            const displayOrder = event.target.value;
            setForm((current) => ({ ...current, displayOrder }));
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
