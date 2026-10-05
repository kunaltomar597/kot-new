import type { MenuDraftResponse, StationView, TaxGroupView } from '@rp/contracts';
import { calendarDateOf, timeOfDayOf } from '@rp/domain';
import { Badge, Button, ConfirmDialog, ErrorState, Icon, LoadingState, useToast } from '@rp/ui-web';
import { createContext, use, useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { shortDateOf } from '../devices/devices-view.js';
import { CategoriesScreen } from './CategoriesScreen.js';
import { ItemEditor } from './ItemEditor.js';
import { ItemsScreen } from './ItemsScreen.js';
import { ModifierGroupsScreen } from './ModifierGroupsScreen.js';

/** Everything the editor shows: the draft, and the tax groups and stations items refer to. */
export interface MenuData {
  readonly draft: MenuDraftResponse;
  readonly taxGroups: readonly TaxGroupView[];
  readonly stations: readonly StationView[];
}

const MenuContext = createContext<{ readonly menu: MenuData; readonly reload: () => void } | null>(
  null,
);

/** The menu as the editor last read it, and a way to read it again after a change. */
export function useMenu(): { readonly menu: MenuData; readonly reload: () => void } {
  const value = use(MenuContext);
  if (value === null) throw new Error('useMenu is only available inside the menu area');
  return value;
}

/** A change to any of these may change what the editor shows. */
const AFFECTS = new Set([
  'MenuDraftChanged',
  'MenuPublished',
  'ItemAvailabilityChanged',
  'RestaurantChanged',
]);

/**
 * The menu editor (P4-02d, MGR-005): items, categories and modifier groups, one page at a time
 * under `/manage/menu`, with the publishing bar above them. The draft is read once for every page
 * and read again when anyone changes it, publishes it or changes an item's availability, so two
 * managers editing at once see each other's changes (`MenuDraftChanged`).
 */
export function MenuArea() {
  const t = useT();
  const controller = useConsole();
  const { data, reload } = useLive(
    async (): Promise<MenuData> => {
      const [draft, taxGroups, stations] = await Promise.all([
        controller.api.getMenuDraft(),
        controller.api.listTaxGroups(),
        controller.api.listStations(),
      ]);
      return { draft, taxGroups: taxGroups.taxGroups, stations: stations.stations };
    },
    (type) => AFFECTS.has(type),
  );

  return (
    <>
      <nav aria-label={t('menuEditor.pages.label')} className="staff-pages">
        <NavLink to="/manage/menu" end className="staff-pages__link">
          {t('menuEditor.pages.items')}
        </NavLink>
        <NavLink to="/manage/menu/categories" className="staff-pages__link">
          {t('menuEditor.pages.categories')}
        </NavLink>
        <NavLink to="/manage/menu/modifiers" className="staff-pages__link">
          {t('menuEditor.pages.modifiers')}
        </NavLink>
      </nav>
      {data.status === 'loading' ? <LoadingState title={t('states.loading')} /> : null}
      {data.status === 'error' ? (
        <ErrorState
          title={t('menuEditor.loadFailed')}
          description={messageOf(data.error, t)}
          onRetry={reload}
          retryLabel={t('states.retry')}
        />
      ) : null}
      {data.status === 'ready' ? (
        <MenuContext value={{ menu: data.value, reload }}>
          <PublishBar draft={data.value.draft} onPublished={reload} />
          <Routes>
            <Route index element={<ItemsScreen />} />
            <Route path="items/new" element={<ItemEditor />} />
            <Route path="items/:itemId" element={<ItemEditor />} />
            <Route path="categories" element={<CategoriesScreen />} />
            <Route path="modifiers" element={<ModifierGroupsScreen />} />
            <Route path="*" element={<Navigate to="/manage/menu" replace />} />
          </Routes>
        </MenuContext>
      ) : null}
    </>
  );
}

/**
 * Which version every ordering surface shows, whether the draft has changes they do not show yet
 * (MENU-013), and publishing them after a confirmation. Availability and stock never wait for it.
 */
function PublishBar({ draft, onPublished }: { draft: MenuDraftResponse; onPublished: () => void }) {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const close = () => {
    setConfirming(false);
    setBusy(false);
    setError(undefined);
  };

  const publish = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await controller.api.publishMenu();
      toast.show({
        title: t(result.published ? 'menuEditor.publish.done' : 'menuEditor.publish.nothingNew', {
          version: result.version,
        }),
        tone: 'success',
      });
      close();
      onPublished();
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  const { published } = draft;
  const at = published === null ? undefined : new Date(published.publishedAt);
  return (
    <section className="menu-publish" aria-label={t('menuEditor.publish.label')}>
      <div className="menu-publish__state">
        <p className="menu-publish__version">
          {published === null || at === undefined
            ? t('menuEditor.publish.never')
            : t('menuEditor.publish.version', {
                version: published.version,
                date: shortDateOf(calendarDateOf(at), t.locale),
                time: timeOfDayOf(at),
              })}
        </p>
        {draft.unpublished ? (
          <Badge tone="warning" icon={<Icon name="warning" />}>
            {t('menuEditor.publish.changes')}
          </Badge>
        ) : (
          <Badge tone="success" icon={<Icon name="check" />}>
            {t('menuEditor.publish.upToDate')}
          </Badge>
        )}
      </div>
      <Button
        variant={draft.unpublished ? 'primary' : 'secondary'}
        startIcon={<Icon name="send" />}
        onClick={() => {
          setConfirming(true);
        }}
      >
        {t('menuEditor.publish.button')}
      </Button>
      {confirming ? (
        <ConfirmDialog
          open
          tone="primary"
          title={t('menuEditor.publish.confirmTitle')}
          description={t('menuEditor.publish.confirmDescription')}
          confirmLabel={t('menuEditor.publish.confirm')}
          cancelLabel={t('menuEditor.publish.cancel')}
          busy={busy}
          onConfirm={() => {
            void publish();
          }}
          onCancel={close}
        >
          {error === undefined ? null : (
            <p role="alert" className="console-notice console-notice--danger">
              {error}
            </p>
          )}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
