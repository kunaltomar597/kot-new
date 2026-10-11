import type { SectionRequest, SectionView, TableRequest, TableView } from '@rp/contracts';
import { Button, Dialog, Select, TextField } from '@rp/ui-web';
import { useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import {
  type FloorProblem,
  type SectionDraft,
  sectionDraftOf,
  sectionRequestOf,
  type TableDraft,
  tableDraftOf,
  tableRequestOf,
} from './floor-view.js';

interface DialogState {
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onClose: () => void;
}

function ErrorNotice({ error }: { error: string | undefined }) {
  return error === undefined ? null : (
    <p role="alert" className="console-notice console-notice--danger">
      {error}
    </p>
  );
}

/** Adds a section, or renames and reorders one (TBL-001). */
export function SectionDialog({
  section,
  nextOrder,
  busy,
  error,
  onSave,
  onClose,
}: DialogState & {
  section: SectionView | undefined;
  nextOrder: number;
  onSave: (request: SectionRequest) => void;
}) {
  const t = useT();
  const formId = useId();
  const [draft, setDraft] = useState<SectionDraft>(() => sectionDraftOf(section, nextOrder));
  const [problems, setProblems] = useState<readonly FloorProblem[]>([]);
  const problemOf = (problem: FloorProblem) =>
    problems.includes(problem) ? t(`floorPage.problems.${problem}`) : undefined;
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={
        section === undefined
          ? t('floorPage.sectionDialog.addTitle')
          : t('floorPage.sectionDialog.editTitle', { name: section.name })
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('floorPage.sectionDialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('floorPage.sectionDialog.save')}
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
          const request = sectionRequestOf(draft);
          if (Array.isArray(request)) setProblems(request);
          else onSave(request);
        }}
      >
        <TextField
          label={t('floorPage.sectionDialog.name')}
          value={draft.name}
          maxLength={40}
          autoComplete="off"
          required
          data-autofocus
          error={problemOf('nameRequired')}
          onChange={(event) => {
            setDraft((current) => ({ ...current, name: event.target.value }));
          }}
        />
        <TextField
          label={t('floorPage.sectionDialog.order')}
          hint={t('floorPage.sectionDialog.orderHint')}
          value={draft.displayOrder}
          inputMode="numeric"
          autoComplete="off"
          error={problemOf('orderInvalid')}
          onChange={(event) => {
            setDraft((current) => ({ ...current, displayOrder: event.target.value }));
          }}
        />
        <ErrorNotice error={error} />
      </form>
    </Dialog>
  );
}

/** Adds a table to a section, or changes its number, seats, section or position (TBL-001). */
export function TableDialog({
  table,
  sectionId,
  sections,
  nextOrder,
  busy,
  error,
  onSave,
  onClose,
}: DialogState & {
  table: TableView | undefined;
  /** The section a new table goes in. */
  sectionId: string;
  /** Active sections, to move a table between them. */
  sections: readonly SectionView[];
  nextOrder: number;
  onSave: (request: TableRequest) => void;
}) {
  const t = useT();
  const formId = useId();
  const [draft, setDraft] = useState<TableDraft>(() => tableDraftOf(table, sectionId, nextOrder));
  const [problems, setProblems] = useState<readonly FloorProblem[]>([]);
  const problemOf = (problem: FloorProblem) =>
    problems.includes(problem) ? t(`floorPage.problems.${problem}`) : undefined;
  const set = (key: keyof TableDraft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={
        table === undefined
          ? t('floorPage.tableDialog.addTitle')
          : t('floorPage.tableDialog.editTitle', { label: table.label })
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('floorPage.tableDialog.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            {t('floorPage.tableDialog.save')}
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
          const request = tableRequestOf(draft);
          if (Array.isArray(request)) setProblems(request);
          else onSave(request);
        }}
      >
        <TextField
          label={t('floorPage.tableDialog.label')}
          hint={t('floorPage.tableDialog.labelHint')}
          value={draft.label}
          maxLength={20}
          autoComplete="off"
          required
          data-autofocus
          error={problemOf('labelRequired')}
          onChange={(event) => {
            set('label', event.target.value);
          }}
        />
        <TextField
          label={t('floorPage.tableDialog.capacity')}
          value={draft.capacity}
          inputMode="numeric"
          autoComplete="off"
          required
          error={problemOf('capacityInvalid')}
          onChange={(event) => {
            set('capacity', event.target.value);
          }}
        />
        <Select
          label={t('floorPage.tableDialog.section')}
          placeholder={t('floorPage.tableDialog.chooseSection')}
          value={draft.sectionId}
          options={sections.map((section) => ({ value: section.id, label: section.name }))}
          error={problemOf('sectionRequired')}
          {...(table !== undefined &&
            draft.sectionId !== table.sectionId &&
            table.layout !== null && { hint: t('floorPage.tableDialog.sectionChangeHint') })}
          onChange={(event) => {
            set('sectionId', event.target.value);
          }}
        />
        <TextField
          label={t('floorPage.tableDialog.order')}
          hint={t('floorPage.tableDialog.orderHint')}
          value={draft.displayOrder}
          inputMode="numeric"
          autoComplete="off"
          error={problemOf('orderInvalid')}
          onChange={(event) => {
            set('displayOrder', event.target.value);
          }}
        />
        <ErrorNotice error={error} />
      </form>
    </Dialog>
  );
}
