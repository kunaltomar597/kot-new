import type { MenuDraftResponse, StationView, TaxGroupView } from '@rp/contracts';
import { Button, ErrorState, LoadingState, Tabs, useToast } from '@rp/ui-web';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { CategoriesTab } from './CategoriesTab.js';
import { GroupsTab } from './GroupsTab.js';
import { ItemsTab } from './ItemsTab.js';

/** What every tab of the editor reads, and how it asks for a fresh copy after a change. */
export interface MenuData {
  readonly draft: MenuDraftResponse;
  readonly taxGroups: readonly TaxGroupView[];
  readonly stations: readonly StationView[];
}

export interface MenuTabProps {
  readonly data: MenuData;
  readonly reload: () => void;
}

/**
 * The menu editor (P4-02d, MGR-005): dishes, categories and option groups as a draft, published
 * in one press so every device switches to the new version together (MENU-013). Availability and
 * stock apply at once (MENU-006). Nothing is deleted; entries are archived (MENU-010).
 */
export function MenuEditor() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const { data, reload } = useLive(
    async (): Promise<MenuData> => {
      const [draft, taxGroups, stations] = await Promise.all([
        controller.api.getMenuDraft(),
        controller.api.listTaxGroups(),
        controller.api.listStations(),
      ]);
      return { draft, taxGroups: taxGroups.taxGroups, stations: stations.stations };
    },
    (type) =>
      type === 'MenuPublished' ||
      type === 'ItemAvailabilityChanged' ||
      type === 'RestaurantChanged',
  );
  const [tab, setTab] = useState('items');
  const [publishing, setPublishing] = useState(false);

  const publish = async () => {
    setPublishing(true);
    try {
      const result = await controller.api.publishMenu();
      toast.show({
        title: result.published
          ? t('menuEditor.published', { version: result.version })
          : t('menuEditor.unchanged', { version: result.version }),
        tone: result.published ? 'success' : 'info',
      });
    } catch (failure) {
      toast.show({ title: messageOf(failure, t), tone: 'danger' });
    } finally {
      setPublishing(false);
    }
  };

  let content: ReactNode;
  if (data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (data.status === 'error') {
    content = (
      <ErrorState
        title={t('menuEditor.loadFailed')}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  } else {
    const props = { data: data.value, reload };
    content = (
      <Tabs
        label={t('menuEditor.tabs.label')}
        value={tab}
        onValueChange={setTab}
        items={[
          { id: 'items', label: t('menuEditor.tabs.items'), content: <ItemsTab {...props} /> },
          {
            id: 'categories',
            label: t('menuEditor.tabs.categories'),
            content: <CategoriesTab {...props} />,
          },
          { id: 'groups', label: t('menuEditor.tabs.groups'), content: <GroupsTab {...props} /> },
        ]}
      />
    );
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-menu">
      <div className="staff-header">
        <h2 id="dashboard-menu" className="dashboard-section__heading">
          {t('menuEditor.title')}
        </h2>
        <Button
          loading={publishing}
          disabled={data.status !== 'ready'}
          onClick={() => {
            void publish();
          }}
        >
          {t('menuEditor.publish')}
        </Button>
      </div>
      <p className="dashboard-section__hint">{t('menuEditor.intro')}</p>
      {/* ONB-006: a printed menu read into a draft to check (P6-04b). */}
      <Link to="/manage/menu/ai-import" className="staff-pages__link">
        {t('aiImport.open')}
      </Link>
      {content}
    </section>
  );
}
