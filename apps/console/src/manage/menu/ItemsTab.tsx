import type { ItemView } from '@rp/contracts';
import { photoUrl } from '@rp/contracts';
import { formatRupees } from '@rp/domain';
import { Badge, Button, EmptyState, Icon, Select, TextField, useToast } from '@rp/ui-web';
import { useCallback, useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { AvailabilityDialog, ItemDialog } from './ItemDialog.js';
import type { MenuTabProps } from './MenuEditor.js';
import {
  categoryPath,
  categoryRows,
  filterItems,
  type ItemFilter,
  priceLabel,
} from './menu-view.js';
import { ReasonDialog } from './ReasonDialog.js';

type Open =
  | { readonly kind: 'ADD' }
  | { readonly kind: 'EDIT' | 'STOCK' | 'ARCHIVE'; readonly item: ItemView };

/** The dishes (MENU-002 to MENU-006): find one, edit it, set its stock, archive or restore it. */
export function ItemsTab({ data, reload }: MenuTabProps) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const [filter, setFilter] = useState<ItemFilter>({ categoryId: '', search: '', archived: false });
  const [open, setOpen] = useState<Open | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const { draft } = data;
  const items = filterItems(draft, filter);
  const combos = new Set(draft.combos.map((combo) => combo.itemId));

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

  const restore = (item: ItemView) => {
    void run(
      () => controller.api.restoreItem({ params: { id: item.id } }),
      t('menuEditor.items.restored', { name: item.name }),
    );
  };

  const empty = filter.archived
    ? t('menuEditor.items.noneArchived')
    : draft.items.some((item) => item.archivedAt === null)
      ? t('menuEditor.items.noMatch')
      : t('menuEditor.items.none');

  return (
    <div className="menu-tab">
      <div className="menu-toolbar">
        <Select
          label={t('menuEditor.items.category')}
          value={filter.categoryId}
          options={[
            { value: '', label: t('menuEditor.items.allCategories') },
            ...categoryRows(draft.categories).map(({ category, depth }) => ({
              value: category.id,
              label: depth === 0 ? category.name : `— ${category.name}`,
            })),
          ]}
          onChange={(event) => {
            setFilter((current) => ({ ...current, categoryId: event.target.value }));
          }}
        />
        <TextField
          label={t('menuEditor.items.search')}
          hint={t('menuEditor.items.searchHint')}
          type="search"
          value={filter.search}
          autoComplete="off"
          onChange={(event) => {
            setFilter((current) => ({ ...current, search: event.target.value }));
          }}
        />
        <label className="menu-toolbar__check">
          <input
            type="checkbox"
            checked={filter.archived}
            onChange={(event) => {
              setFilter((current) => ({ ...current, archived: event.target.checked }));
            }}
          />
          {t('menuEditor.items.showArchived')}
        </label>
        <Button
          startIcon={<Icon name="plus" />}
          onClick={() => {
            setOpen({ kind: 'ADD' });
          }}
        >
          {t('menuEditor.items.add')}
        </Button>
      </div>
      {error !== undefined && open === undefined ? (
        <p role="alert" className="console-notice console-notice--danger">
          {error}
        </p>
      ) : null}
      {items.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        <ul className="staff-list" aria-label={t('menuEditor.tabs.items')}>
          {items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              category={categoryPath(draft.categories, item.categoryId)}
              isCombo={combos.has(item.id)}
              busy={busy}
              onEdit={() => {
                setOpen({ kind: 'EDIT', item });
              }}
              onStock={() => {
                setOpen({ kind: 'STOCK', item });
              }}
              onArchive={() => {
                setOpen({ kind: 'ARCHIVE', item });
              }}
              onRestore={() => {
                restore(item);
              }}
            />
          ))}
        </ul>
      )}
      {open?.kind === 'ADD' || open?.kind === 'EDIT' ? (
        <ItemDialog
          data={data}
          item={open.kind === 'EDIT' ? open.item : undefined}
          defaultCategoryId={filter.categoryId}
          onSaved={(name, added) => {
            toast.show({
              title: added
                ? t('menuEditor.items.added', { name })
                : t('menuEditor.items.saved', { name }),
              tone: 'success',
            });
            close();
            reload();
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'STOCK' ? (
        <AvailabilityDialog
          item={open.item}
          busy={busy}
          error={error}
          onSave={(body) => {
            void run(
              () => controller.api.setItemAvailability({ params: { id: open.item.id }, body }),
              t('menuEditor.availability.saved', { name: open.item.name }),
            );
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'ARCHIVE' ? (
        <ReasonDialog
          title={t('menuEditor.items.archiveTitle', { name: open.item.name })}
          description={t('menuEditor.items.archiveDescription')}
          confirmLabel={t('menuEditor.archive')}
          busy={busy}
          error={error}
          onConfirm={(reason) => {
            void run(
              () => controller.api.archiveItem({ params: { id: open.item.id }, body: { reason } }),
              t('menuEditor.items.archivedToast', { name: open.item.name }),
            );
          }}
          onCancel={close}
        />
      ) : null}
    </div>
  );
}

/** One dish: photo, name, category, price, food type and stock in words, and its actions. */
function ItemRow({
  item,
  category,
  isCombo,
  busy,
  onEdit,
  onStock,
  onArchive,
  onRestore,
}: {
  item: ItemView;
  category: string;
  isCombo: boolean;
  busy: boolean;
  onEdit: () => void;
  onStock: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const t = useT();
  const price = priceLabel(item);
  const archived = item.archivedAt !== null;
  const variants = item.variants.filter((variant) => variant.archivedAt === null).length;
  return (
    <li className="staff-row menu-row" data-inactive={archived ? '' : undefined}>
      {item.photoId === null ? null : (
        <img
          className="menu-row__photo"
          src={photoUrl(item.photoId, 160)}
          alt={t('menuEditor.item.photoAlt', { name: item.name })}
          width={64}
          height={64}
          loading="lazy"
        />
      )}
      <div className="staff-row__who">
        <h3 className="staff-row__name">
          {item.name}
          {item.shortCode === null ? null : (
            <span className="menu-row__code">{item.shortCode}</span>
          )}
        </h3>
        <p className="staff-row__role">
          {t('menuEditor.items.line', {
            category,
            price: price.from
              ? t('menuEditor.items.priceFrom', { price: formatRupees(price.paise) })
              : formatRupees(price.paise),
          })}
        </p>
        <p className="staff-row__states">
          <Badge
            tone={
              item.foodType === 'VEG' ? 'success' : item.foodType === 'EGG' ? 'warning' : 'danger'
            }
          >
            {t(`pos.menu.foodType.${item.foodType}`)}
          </Badge>
          {archived ? (
            <Badge tone="neutral" icon={<Icon name="ban" />}>
              {t('menuEditor.archived')}
            </Badge>
          ) : item.available ? (
            <Badge tone="success" icon={<Icon name="check" />}>
              {item.stockCount === null
                ? t('menuEditor.items.available')
                : t('menuEditor.items.stockLeft', { count: item.stockCount })}
            </Badge>
          ) : (
            <Badge tone="danger" icon={<Icon name="xCircle" />}>
              {t('menuEditor.items.soldOut')}
            </Badge>
          )}
          {isCombo ? <Badge tone="info">{t('menuEditor.items.combo')}</Badge> : null}
          {variants === 0 ? null : (
            <Badge tone="neutral">{t('menuEditor.items.variants', { count: variants })}</Badge>
          )}
        </p>
      </div>
      <div
        className="staff-row__actions"
        role="group"
        aria-label={t('menuEditor.items.actionsFor', { name: item.name })}
      >
        {archived ? (
          <Button variant="secondary" disabled={busy} onClick={onRestore}>
            {t('menuEditor.restore')}
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onEdit}>
              {t('menuEditor.edit')}
            </Button>
            <Button variant="secondary" onClick={onStock}>
              {t('menuEditor.items.availability')}
            </Button>
            <Button variant="secondary" onClick={onArchive}>
              {t('menuEditor.archive')}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
