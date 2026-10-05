import type { ItemView } from '@rp/contracts';
import { formatRupees } from '@rp/domain';
import { Badge, Button, EmptyState, Icon, TextField, useToast } from '@rp/ui-web';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { ReasonDialog } from '../../billing/ReasonDialog.js';
import { AvailabilityDialog } from './AvailabilityDialog.js';
import { useMenu } from './MenuArea.js';
import { type ItemGroup, itemGroups, missingChannels, priceRange } from './menu-view.js';

interface Open {
  readonly kind: 'ARCHIVE' | 'AVAILABILITY';
  readonly item: ItemView;
}

/**
 * Every item, grouped by category in menu order (P4-02d, MENU-001, MENU-002): its price or the
 * range of its sizes, its food type, and whether it is a combo, archived, out of stock, counted
 * or missing from a channel, in words as well as colour. Items are searched by name, short code,
 * tag or search word (MENU-011); availability changes at once (MENU-006), everything else when
 * the menu is published.
 */
export function ItemsScreen() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const navigate = useNavigate();
  const { menu, reload } = useMenu();
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [open, setOpen] = useState<Open | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const close = () => {
    setOpen(undefined);
    setBusy(false);
    setError(undefined);
  };

  const archive = async (item: ItemView, reason: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await controller.api.archiveItem({ params: { id: item.id }, body: { reason } });
      toast.show({
        title: t('menuEditor.items.archivedToast', { name: item.name }),
        tone: 'success',
      });
      close();
      reload();
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  const restore = async (item: ItemView) => {
    try {
      await controller.api.restoreItem({ params: { id: item.id } });
      toast.show({
        title: t('menuEditor.items.restoredToast', { name: item.name }),
        tone: 'success',
      });
      reload();
    } catch (failure) {
      toast.show({ title: messageOf(failure, t), tone: 'danger' });
    }
  };

  const { draft } = menu;
  const groups = itemGroups(draft, { query, archived });
  const combos = new Set(draft.combos.map((combo) => combo.itemId));
  const hasItems = draft.items.some((item) => archived || item.archivedAt === null);
  const searching = query.trim() !== '';

  return (
    <section className="dashboard-section" aria-labelledby="menu-items">
      <div className="staff-header">
        <h2 id="menu-items" className="dashboard-section__heading">
          {t('menuEditor.items.title')}
        </h2>
        <Button
          startIcon={<Icon name="plus" />}
          onClick={() => {
            void navigate('/manage/menu/items/new');
          }}
        >
          {t('menuEditor.items.add')}
        </Button>
      </div>
      <p className="dashboard-section__hint">{t('menuEditor.items.intro')}</p>
      <div className="menu-filter">
        <TextField
          type="search"
          label={t('menuEditor.items.search')}
          hint={t('menuEditor.items.searchHint')}
          value={query}
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <label className="console-check">
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => {
              setArchived(event.target.checked);
            }}
          />
          {t('menuEditor.items.showArchived')}
        </label>
      </div>
      {!hasItems && !searching ? <EmptyState title={t('menuEditor.items.none')} /> : null}
      {searching && groups.length === 0 ? (
        <EmptyState title={t('menuEditor.items.noMatch', { query: query.trim() })} />
      ) : null}
      {groups.map((group) => (
        <CategoryGroup
          key={group.category.id}
          group={group}
          combos={combos}
          onAction={(kind, item) => {
            if (kind === 'EDIT') void navigate(`/manage/menu/items/${item.id}`);
            else if (kind === 'RESTORE') void restore(item);
            else setOpen({ kind, item });
          }}
        />
      ))}
      {open?.kind === 'ARCHIVE' ? (
        <ReasonDialog
          title={t('menuEditor.items.archiveDialog.title', { name: open.item.name })}
          description={t('menuEditor.items.archiveDialog.description')}
          label={t('menuEditor.items.archiveDialog.reason')}
          confirmLabel={t('menuEditor.items.archiveDialog.confirm')}
          tone="danger"
          busy={busy}
          error={error}
          onConfirm={(reason) => {
            void archive(open.item, reason);
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'AVAILABILITY' ? (
        <AvailabilityDialog
          item={open.item}
          onSaved={() => {
            toast.show({
              title: t('menuEditor.availabilityDialog.saved', { name: open.item.name }),
              tone: 'success',
            });
            close();
            reload();
          }}
          onClose={close}
        />
      ) : null}
    </section>
  );
}

type ItemAction = 'EDIT' | 'AVAILABILITY' | 'ARCHIVE' | 'RESTORE';

/** One category (or sub-category) and its items. */
function CategoryGroup({
  group,
  combos,
  onAction,
}: {
  group: ItemGroup;
  combos: ReadonlySet<string>;
  onAction: (action: ItemAction, item: ItemView) => void;
}) {
  const t = useT();
  const { category, parent } = group;
  const Heading = parent === null ? 'h3' : 'h4';
  return (
    <div className="menu-group" data-sub={parent === null ? undefined : true}>
      <Heading className="menu-group__heading">
        {parent === null
          ? category.name
          : t('menuEditor.categoryPath', { parent: parent.name, name: category.name })}
        {category.archivedAt === null ? null : (
          <Badge tone="neutral">{t('menuEditor.items.archivedCategory')}</Badge>
        )}
      </Heading>
      {group.items.length === 0 ? (
        <p className="menu-group__empty">{t('menuEditor.items.emptyCategory')}</p>
      ) : (
        <ul className="staff-list">
          {group.items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              combo={combos.has(item.id)}
              onAction={(action) => {
                onAction(action, item);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One item: what it costs and its state, in words (not colour alone), and its actions. */
function ItemRow({
  item,
  combo,
  onAction,
}: {
  item: ItemView;
  combo: boolean;
  onAction: (action: ItemAction) => void;
}) {
  const t = useT();
  const controller = useConsole();
  const { low, high } = priceRange(item);
  const sizes = item.variants.filter((variant) => variant.archivedAt === null).length;
  const missing = missingChannels(item);
  const active = item.archivedAt === null;
  const actions: readonly ItemAction[] = active ? ['EDIT', 'AVAILABILITY', 'ARCHIVE'] : ['RESTORE'];
  return (
    <li className="staff-row menu-row" data-inactive={active ? undefined : true}>
      {item.photoId === null ? null : (
        <img
          className="menu-row__photo"
          src={controller.photoSrc(item.photoId, 160)}
          alt=""
          width={64}
          height={64}
          loading="lazy"
        />
      )}
      <div className="staff-row__who">
        <p className="staff-row__name">
          {item.name}
          {item.shortCode === null ? null : (
            <span className="menu-row__code">{item.shortCode}</span>
          )}
        </p>
        <p className="staff-row__role menu-facts">
          <span>
            {low === high
              ? formatRupees(low)
              : t('menuEditor.items.priceRange', {
                  low: formatRupees(low),
                  high: formatRupees(high),
                })}
          </span>
          {sizes === 0 ? null : <span>{t('menuEditor.items.sizes', { count: sizes })}</span>}
        </p>
        <p className="staff-row__states">
          <Badge tone={FOOD_TYPE_TONES[item.foodType]}>
            {t(`pos.menu.foodType.${item.foodType}`)}
          </Badge>
          {combo ? <Badge tone="info">{t('menuEditor.items.combo')}</Badge> : null}
          {active ? null : <Badge tone="neutral">{t('menuEditor.items.archived')}</Badge>}
          {active && !item.available ? (
            <Badge tone="danger" icon={<Icon name="ban" />}>
              {t('menuEditor.items.outOfStock')}
            </Badge>
          ) : null}
          {active && item.stockCount !== null ? (
            <Badge tone="warning">{t('menuEditor.items.left', { count: item.stockCount })}</Badge>
          ) : null}
          {missing.length === 0 ? null : (
            <Badge tone="neutral">
              {t('menuEditor.items.notOn', {
                channels: new Intl.ListFormat(t.locale, { type: 'conjunction' }).format(
                  missing.map((channel) => t(`menuEditor.editor.channel.${channel}`)),
                ),
              })}
            </Badge>
          )}
        </p>
      </div>
      <div
        className="staff-row__actions"
        role="group"
        aria-label={t('menuEditor.items.actionsFor', { name: item.name })}
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

/** The usual marks: green for veg, red for non-veg, yellow for egg; always with the word. */
const FOOD_TYPE_TONES = { VEG: 'success', NON_VEG: 'danger', EGG: 'warning' } as const;

const ACTION_LABELS = {
  EDIT: 'menuEditor.items.edit',
  AVAILABILITY: 'menuEditor.items.availability',
  ARCHIVE: 'menuEditor.items.archive',
  RESTORE: 'menuEditor.items.restore',
} as const;
