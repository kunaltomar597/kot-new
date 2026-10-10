import type { FloorResponse, SectionView, TableView } from '@rp/contracts';
import { Select, TextField } from '@rp/ui-web';
import { useState } from 'react';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { FormDialog } from './FormDialog.js';
import {
  activeSections,
  checkSection,
  checkTable,
  emptySectionForm,
  emptyTableForm,
  nextTablePlace,
  type SectionField,
  type SectionForm,
  sectionFormOf,
  sectionRequestOf,
  type TableField,
  type TableForm,
  tableFormOf,
  tableRequestOf,
} from './floor-view.js';

/** Adds a section or changes its name and place (TBL-001); the server audits it. */
export function SectionDialog({
  section,
  floor,
  onSaved,
  onClose,
}: {
  /** Undefined to add one. */
  section: SectionView | undefined;
  floor: FloorResponse;
  onSaved: (saved: SectionView) => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const [form, setForm] = useState<SectionForm>(() =>
    section === undefined ? emptySectionForm(floor) : sectionFormOf(section),
  );
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const problems = checkSection(form, floor, section?.id);
  const problemOf = (field: SectionField): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined
      ? t(`floor.sectionDialog.problems.${problem}`)
      : undefined;
  };

  const save = async () => {
    setSubmitted(true);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    setError(undefined);
    const body = sectionRequestOf(form);
    try {
      onSaved(
        section === undefined
          ? await controller.api.createSection({ body })
          : await controller.api.updateSection({ params: { sectionId: section.id }, body }),
      );
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  return (
    <FormDialog
      title={
        section === undefined
          ? t('floor.sectionDialog.addTitle')
          : t('floor.sectionDialog.editTitle', { name: section.name })
      }
      busy={busy}
      error={error}
      onConfirm={() => {
        void save();
      }}
      onClose={onClose}
    >
      <TextField
        label={t('floor.sectionDialog.name')}
        hint={t('floor.sectionDialog.nameHint')}
        value={form.name}
        maxLength={40}
        autoComplete="off"
        required
        data-autofocus
        error={problemOf('name')}
        onChange={(event) => {
          const name = event.target.value;
          setForm((current) => ({ ...current, name }));
        }}
      />
      <TextField
        label={t('floor.sectionDialog.place')}
        hint={t('floor.sectionDialog.placeHint')}
        inputMode="numeric"
        autoComplete="off"
        value={form.displayOrder}
        maxLength={3}
        error={problemOf('displayOrder')}
        onChange={(event) => {
          const displayOrder = event.target.value;
          setForm((current) => ({ ...current, displayOrder }));
        }}
      />
    </FormDialog>
  );
}

/**
 * Adds a table to a section or changes its label, seats, section and place (TBL-001); the server
 * audits it. A new table goes after the tables of the section chosen, until a place is typed.
 */
export function TableDialog({
  table,
  sectionId,
  floor,
  onSaved,
  onClose,
}: {
  /** Undefined to add one. */
  table: TableView | undefined;
  /** The section a new table goes in, until another is chosen. */
  sectionId?: string;
  floor: FloorResponse;
  onSaved: (saved: TableView) => void;
  onClose: () => void;
}) {
  const t = useT();
  const controller = useConsole();
  const [form, setForm] = useState<TableForm>(() =>
    table === undefined ? emptyTableForm(floor, sectionId) : tableFormOf(table),
  );
  const [placeTyped, setPlaceTyped] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const problems = checkTable(form, floor, table?.id);
  const problemOf = (field: TableField): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined
      ? t(`floor.tableDialog.problems.${problem}`)
      : undefined;
  };

  const save = async () => {
    setSubmitted(true);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    setError(undefined);
    const body = tableRequestOf(form);
    try {
      onSaved(
        table === undefined
          ? await controller.api.createTable({ body })
          : await controller.api.updateTable({ params: { tableId: table.id }, body }),
      );
    } catch (failure) {
      setError(messageOf(failure, t));
      setBusy(false);
    }
  };

  return (
    <FormDialog
      title={
        table === undefined
          ? t('floor.tableDialog.addTitle')
          : t('floor.tableDialog.editTitle', { table: table.label })
      }
      busy={busy}
      error={error}
      onConfirm={() => {
        void save();
      }}
      onClose={onClose}
    >
      <TextField
        label={t('floor.tableDialog.label')}
        hint={t('floor.tableDialog.labelHint')}
        value={form.label}
        maxLength={20}
        autoComplete="off"
        required
        data-autofocus
        error={problemOf('label')}
        onChange={(event) => {
          const label = event.target.value;
          setForm((current) => ({ ...current, label }));
        }}
      />
      <TextField
        label={t('floor.tableDialog.capacity')}
        inputMode="numeric"
        autoComplete="off"
        value={form.capacity}
        maxLength={2}
        required
        error={problemOf('capacity')}
        onChange={(event) => {
          const capacity = event.target.value;
          setForm((current) => ({ ...current, capacity }));
        }}
      />
      <Select
        label={t('floor.tableDialog.section')}
        value={form.sectionId}
        placeholder={form.sectionId === '' ? t('floor.tableDialog.chooseSection') : undefined}
        options={activeSections(floor).map((section) => ({
          value: section.id,
          label: section.name,
        }))}
        required
        error={problemOf('sectionId')}
        onChange={(event) => {
          const chosen = event.target.value;
          setForm((current) => ({
            ...current,
            sectionId: chosen,
            // A new table goes last in the section chosen, unless a place was typed.
            ...(table === undefined &&
              !placeTyped &&
              chosen !== '' && { displayOrder: String(nextTablePlace(floor, chosen)) }),
          }));
        }}
      />
      <TextField
        label={t('floor.tableDialog.place')}
        hint={t('floor.tableDialog.placeHint')}
        inputMode="numeric"
        autoComplete="off"
        value={form.displayOrder}
        maxLength={4}
        error={problemOf('displayOrder')}
        onChange={(event) => {
          const displayOrder = event.target.value;
          setPlaceTyped(true);
          setForm((current) => ({ ...current, displayOrder }));
        }}
      />
    </FormDialog>
  );
}
