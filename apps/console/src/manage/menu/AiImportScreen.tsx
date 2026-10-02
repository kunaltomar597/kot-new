import {
  type AiMenuImportView,
  type MenuImportReport,
  type StationView,
  type TaxGroupView,
} from '@rp/contracts';
import {
  Badge,
  Button,
  ErrorState,
  LoadingState,
  Select,
  Spinner,
  TextField,
  useToast,
} from '@rp/ui-web';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useConsole } from '../../app/console-context.js';
import { useT } from '../../app/i18n.js';
import { messageOf } from '../../app/messages.js';
import { useLive } from '../../app/use-live.js';
import { base64Of } from '../PhotoPicker.js';
import {
  checkSection,
  dishProblems,
  type FoodTypeChoice,
  readyToImport,
  removeDish,
  type ReviewDish,
  type ReviewSection,
  type ReviewState,
  reviewOf,
  reviewProgress,
  reviewRequest,
  updateDish,
  updateSection,
} from './ai-import-view.js';
import { FOOD_TYPES, SPICE_LEVELS } from './menu-view.js';

type Translate = ReturnType<typeof useT>;

const MAX_FILES = 10;
const PHOTO_MAX_BYTES = 15 * 1024 * 1024;
const PDF_MAX_BYTES = 20 * 1024 * 1024;
const POLL_MS = 3_000;
/** The import being read or checked, so a reload comes back to it. */
const STORAGE_KEY = 'rp.console.aiImport';

function storedImport(): string | undefined {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeImport(id: string | undefined): void {
  try {
    if (id === undefined) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // The page still works; it just does not come back after a reload.
  }
}

/**
 * AI-assisted menu import (P6-04b, ONB-006): photos or a PDF of the printed menu go to the vendor's
 * service, which reads them into a draft; the manager then checks every dish (correcting what was
 * misread, and choosing each section's station and tax group, which no printed menu says) and
 * only then adds the dishes, through the template import. The server refuses an import with any
 * dish unchecked, too.
 */
export function AiImportScreen() {
  const t = useT();
  const controller = useConsole();
  const toast = useToast();
  const setup = useLive(
    async () => {
      const [taxGroups, stations] = await Promise.all([
        controller.api.listTaxGroups(),
        controller.api.listStations(),
      ]);
      return { taxGroups: taxGroups.taxGroups, stations: stations.stations };
    },
    (type) => type === 'RestaurantChanged',
  );
  const [importId, setImportId] = useState<string | undefined>(storedImport);
  const [view, setView] = useState<AiMenuImportView | undefined>();
  const [review, setReview] = useState<ReviewState | undefined>();
  const [report, setReport] = useState<MenuImportReport | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // While the vendor reads the menu, ask how it is going.
  const reading =
    importId !== undefined &&
    (view === undefined || view.status === 'QUEUED' || view.status === 'RUNNING');
  useEffect(() => {
    if (!reading) return;
    let stopped = false;
    const ask = () => {
      controller.api.getAiMenuImport({ params: { importId } }).then(
        (fresh) => {
          if (!stopped) setView(fresh);
        },
        (error: unknown) => {
          if (stopped) return;
          setFailure(messageOf(error, t));
          setView(undefined);
          setImportId(undefined);
          storeImport(undefined);
        },
      );
    };
    ask();
    const timer = setInterval(ask, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [controller, importId, reading, t]);

  // The draft arrived: make it the review, with the restaurant's first station and tax group.
  const draft = view?.status === 'DONE' ? view.draft : null;
  const ready = setup.data.status === 'ready' ? setup.data.value : undefined;
  if (draft !== null && review === undefined && ready !== undefined) {
    setReview(
      reviewOf(draft, {
        stationId: ready.stations[0]?.id ?? '',
        taxGroupId: ready.taxGroups[0]?.id ?? '',
      }),
    );
  }

  const startAgain = () => {
    setImportId(undefined);
    storeImport(undefined);
    setView(undefined);
    setReview(undefined);
    setReport(undefined);
    setFailure(undefined);
  };

  const send = async (files: readonly File[]) => {
    setBusy(true);
    setFailure(undefined);
    try {
      const started = await controller.api.startAiMenuImport({
        body: {
          files: await Promise.all(
            files.map(async (file) => ({
              name: file.name,
              contentType: file.type as
                'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf',
              contentBase64: await base64Of(file),
            })),
          ),
        },
      });
      setView(started);
      setImportId(started.id);
      storeImport(started.id);
    } catch (error) {
      setFailure(messageOf(error, t));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (review === undefined || importId === undefined) return;
    setBusy(true);
    try {
      const answer = await controller.api.commitAiMenuImport({
        params: { importId },
        body: reviewRequest(review),
      });
      setReport(answer);
      if (answer.committed) storeImport(undefined);
    } catch (error) {
      toast.show({ title: messageOf(error, t), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  let content: ReactNode;
  if (report?.committed === true && report.summary !== null) {
    content = (
      <section className="device-group" aria-labelledby="ai-import-done">
        <h3 id="ai-import-done" className="device-group__heading">
          {t('aiImport.done')}
        </h3>
        <p>
          {t('aiImport.doneSummary', {
            items: report.summary.items,
            categories: report.summary.categories,
            version: report.menuVersion ?? 0,
          })}
        </p>
        <Link to="/manage/menu" className="staff-pages__link">
          {t('aiImport.toEditor')}
        </Link>
      </section>
    );
  } else if (setup.data.status === 'loading') {
    content = <LoadingState title={t('states.loading')} />;
  } else if (setup.data.status === 'error') {
    content = (
      <ErrorState
        title={t('menuEditor.loadFailed')}
        description={messageOf(setup.data.error, t)}
        onRetry={setup.reload}
        retryLabel={t('states.retry')}
      />
    );
  } else if (view?.status === 'FAILED') {
    content = (
      <ErrorState
        title={t('aiImport.failed')}
        description={view.error?.message ?? ''}
        onRetry={startAgain}
        retryLabel={t('aiImport.startAgain')}
      />
    );
  } else if (reading) {
    content = (
      <div className="ai-import__reading" role="status">
        <Spinner />
        <p>{t('aiImport.reading')}</p>
        <p className="dashboard-section__hint">{t('aiImport.readingHint')}</p>
      </div>
    );
  } else if (review !== undefined) {
    content = (
      <Review
        review={review}
        taxGroups={setup.data.value.taxGroups}
        stations={setup.data.value.stations}
        report={report}
        busy={busy}
        onChange={setReview}
        onAdd={() => {
          void add();
        }}
      />
    );
  } else {
    content = (
      <Chooser
        busy={busy}
        failure={failure}
        onSend={(files) => {
          void send(files);
        }}
      />
    );
  }

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-ai-import">
      <div className="staff-header">
        <h2 id="dashboard-ai-import" className="dashboard-section__heading">
          {t('aiImport.title')}
        </h2>
        <Link to="/manage/menu" className="staff-pages__link">
          {t('aiImport.back')}
        </Link>
      </div>
      <p className="dashboard-section__hint">{t('aiImport.intro')}</p>
      {content}
    </section>
  );
}

/** Choosing the photos or PDF, checked for count and size before anything is sent. */
function Chooser({
  busy,
  failure,
  onSend,
}: {
  busy: boolean;
  failure: string | undefined;
  onSend: (files: readonly File[]) => void;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<readonly File[]>([]);
  const tooLarge = files.find(
    (file) => file.size > (file.type === 'application/pdf' ? PDF_MAX_BYTES : PHOTO_MAX_BYTES),
  );
  const problem =
    files.length > MAX_FILES
      ? t('aiImport.tooMany')
      : tooLarge === undefined
        ? undefined
        : t('aiImport.tooLarge', { name: tooLarge.name });
  return (
    <div className="ai-import__chooser">
      <p className="menu-photo__label">{t('aiImport.files')}</p>
      <p className="dashboard-section__hint">{t('aiImport.filesHint')}</p>
      <input
        ref={input}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,application/pdf"
        className="menu-photo__input"
        aria-label={t('aiImport.files')}
        onChange={(event) => {
          setFiles([...files, ...Array.from(event.target.files ?? [])]);
          event.target.value = '';
        }}
      />
      <Button
        variant="secondary"
        onClick={() => {
          input.current?.click();
        }}
      >
        {t('aiImport.choose')}
      </Button>
      {files.length === 0 ? null : (
        <ul className="staff-list" aria-label={t('aiImport.files')}>
          {files.map((file, index) => (
            <li key={`${file.name}-${String(index)}`} className="staff-row">
              <span className="staff-row__name">{file.name}</span>
              <Button
                variant="ghost"
                aria-label={t('aiImport.removeFile', { name: file.name })}
                onClick={() => {
                  setFiles(files.filter((_, at) => at !== index));
                }}
              >
                {t('aiImport.review.leaveOut')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {problem === undefined ? null : <p role="alert">{problem}</p>}
      {failure === undefined ? null : <p role="alert">{failure}</p>}
      <Button
        loading={busy}
        disabled={files.length === 0 || problem !== undefined}
        onClick={() => {
          onSend(files);
        }}
      >
        {t('aiImport.read')}
      </Button>
    </div>
  );
}

function Review({
  review,
  taxGroups,
  stations,
  report,
  busy,
  onChange,
  onAdd,
}: {
  review: ReviewState;
  taxGroups: readonly TaxGroupView[];
  stations: readonly StationView[];
  report: MenuImportReport | undefined;
  busy: boolean;
  onChange: (next: ReviewState) => void;
  onAdd: () => void;
}) {
  const t = useT();
  const progress = reviewProgress(review);
  const canAdd = readyToImport(review);
  return (
    <>
      <section className="device-group" aria-labelledby="ai-import-review">
        <h3 id="ai-import-review" className="device-group__heading">
          {t('aiImport.review.title')}
        </h3>
        <p className="dashboard-section__hint">{t('aiImport.review.hint')}</p>
        <p role="status">
          <Badge tone={progress.checked === progress.total ? 'success' : 'warning'}>
            {t('aiImport.review.progress', progress)}
          </Badge>
        </p>
        {review.notes.length === 0 ? null : (
          <div>
            <p className="menu-photo__label">{t('aiImport.review.notes')}</p>
            <ul>
              {review.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        )}
        {review.addOns.length === 0 ? null : (
          <p className="dashboard-section__hint">
            {t('aiImport.review.addOns', {
              names: review.addOns.map((addOn) => addOn.group).join(', '),
            })}
          </p>
        )}
      </section>
      {review.sections.map((section) => (
        <SectionReview
          key={section.key}
          section={section}
          taxGroups={taxGroups}
          stations={stations}
          onSection={(change) => {
            onChange(updateSection(review, section.key, change));
          }}
          onCheckAll={() => {
            onChange(checkSection(review, section.key));
          }}
          onDish={(dishKey, change) => {
            onChange(updateDish(review, dishKey, change));
          }}
          onRemove={(dishKey) => {
            onChange(removeDish(review, dishKey));
          }}
        />
      ))}
      {report !== undefined && !report.committed && report.issues.length > 0 ? (
        <div role="alert">
          <p>{t('aiImport.issues')}</p>
          <ul>
            {report.issues.map((issue) => (
              <li
                key={`${issue.sheet}-${String(issue.row)}-${issue.column ?? ''}-${issue.message}`}
              >
                {t('aiImport.issue', {
                  sheet: issue.sheet,
                  row: issue.row ?? 0,
                  message: issue.message,
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {canAdd ? null : <p className="dashboard-section__hint">{t('aiImport.review.notReady')}</p>}
      <Button loading={busy} disabled={!canAdd} onClick={onAdd}>
        {t('aiImport.review.add')}
      </Button>
    </>
  );
}

function SectionReview({
  section,
  taxGroups,
  stations,
  onSection,
  onCheckAll,
  onDish,
  onRemove,
}: {
  section: ReviewSection;
  taxGroups: readonly TaxGroupView[];
  stations: readonly StationView[];
  onSection: (change: Partial<Pick<ReviewSection, 'name' | 'stationId' | 'taxGroupId'>>) => void;
  onCheckAll: () => void;
  onDish: (dishKey: string, change: Partial<Omit<ReviewDish, 'key'>>) => void;
  onRemove: (dishKey: string) => void;
}) {
  const t = useT();
  const headingId = `ai-section-${section.key}`;
  return (
    <section className="device-group" aria-labelledby={headingId}>
      <h3 id={headingId} className="device-group__heading">
        {section.name}
      </h3>
      <div className="menu-form__row">
        <TextField
          label={t('aiImport.review.sectionName')}
          value={section.name}
          onChange={(event) => {
            onSection({ name: event.target.value });
          }}
        />
        <Select
          label={t('aiImport.review.station')}
          value={section.stationId}
          options={stations.map((station) => ({ value: station.id, label: station.name }))}
          onChange={(event) => {
            onSection({ stationId: event.target.value });
          }}
        />
        <Select
          label={t('aiImport.review.taxGroup')}
          value={section.taxGroupId}
          options={taxGroups.map((group) => ({ value: group.id, label: group.name }))}
          onChange={(event) => {
            onSection({ taxGroupId: event.target.value });
          }}
        />
      </div>
      <Button variant="secondary" onClick={onCheckAll}>
        {t('aiImport.review.checkAll', { name: section.name })}
      </Button>
      <ul className="staff-list" aria-labelledby={headingId}>
        {section.dishes.map((dish) => (
          <DishReview
            key={dish.key}
            dish={dish}
            t={t}
            onChange={(change) => {
              onDish(dish.key, change);
            }}
            onRemove={() => {
              onRemove(dish.key);
            }}
          />
        ))}
      </ul>
    </section>
  );
}

function DishReview({
  dish,
  t,
  onChange,
  onRemove,
}: {
  dish: ReviewDish;
  t: Translate;
  onChange: (change: Partial<Omit<ReviewDish, 'key'>>) => void;
  onRemove: () => void;
}) {
  const problems = dishProblems(dish);
  const label = dish.name.trim() === '' ? t('aiImport.review.name') : dish.name;
  return (
    <li className="staff-row ai-import__dish">
      <div className="menu-form__row">
        <TextField
          label={t('aiImport.review.name')}
          value={dish.name}
          error={problems.includes('NAME') ? t('aiImport.review.problem.NAME') : undefined}
          onChange={(event) => {
            onChange({ name: event.target.value });
          }}
        />
        {dish.variants.length === 0 ? (
          <TextField
            label={t('aiImport.review.price')}
            inputMode="decimal"
            value={dish.price}
            error={problems.includes('PRICE') ? t('aiImport.review.problem.PRICE') : undefined}
            onChange={(event) => {
              onChange({ price: event.target.value });
            }}
          />
        ) : null}
        <Select
          label={t('aiImport.review.foodType')}
          placeholder={t('aiImport.review.chooseFoodType')}
          value={dish.foodType}
          options={FOOD_TYPES.map((type) => ({
            value: type,
            label: t(`pos.menu.foodType.${type}`),
          }))}
          error={
            problems.includes('FOOD_TYPE') ? t('aiImport.review.problem.FOOD_TYPE') : undefined
          }
          onChange={(event) => {
            onChange({ foodType: event.target.value as FoodTypeChoice });
          }}
        />
        <Select
          label={t('aiImport.review.spice')}
          value={String(dish.spiceLevel)}
          options={SPICE_LEVELS.map((level, index) => ({
            value: String(index),
            label: t(`menuEditor.item.spice.${level}`),
          }))}
          onChange={(event) => {
            onChange({ spiceLevel: Number(event.target.value) });
          }}
        />
      </div>
      {dish.variants.length === 0 ? null : (
        <fieldset className="menu-form__section">
          <legend>{t('aiImport.review.sizes')}</legend>
          {dish.variants.map((variant, index) => (
            <div key={variant.key} className="menu-form__row">
              <TextField
                label={t('aiImport.review.sizeName', { number: index + 1 })}
                value={variant.name}
                onChange={(event) => {
                  onChange({
                    variants: dish.variants.map((entry) =>
                      entry.key === variant.key ? { ...entry, name: event.target.value } : entry,
                    ),
                  });
                }}
              />
              <TextField
                label={t('aiImport.review.sizePrice', { name: variant.name })}
                inputMode="decimal"
                value={variant.price}
                onChange={(event) => {
                  onChange({
                    variants: dish.variants.map((entry) =>
                      entry.key === variant.key ? { ...entry, price: event.target.value } : entry,
                    ),
                  });
                }}
              />
            </div>
          ))}
          {problems.includes('PRICE') ? (
            <p role="alert">{t('aiImport.review.problem.PRICE')}</p>
          ) : null}
        </fieldset>
      )}
      <TextField
        label={t('aiImport.review.description')}
        value={dish.description}
        onChange={(event) => {
          onChange({ description: event.target.value });
        }}
      />
      {dish.note === null ? null : (
        <p className="ai-import__unsure">{t('aiImport.review.unsure', { note: dish.note })}</p>
      )}
      <div className="staff-row__actions">
        <label className="console-check">
          <input
            type="checkbox"
            checked={dish.checked}
            aria-label={t('aiImport.review.checkedFor', { name: label })}
            onChange={(event) => {
              onChange({ checked: event.target.checked });
            }}
          />
          {t('aiImport.review.checked')}
        </label>
        <Button
          variant="ghost"
          aria-label={t('aiImport.review.leaveOutFor', { name: label })}
          onClick={onRemove}
        >
          {t('aiImport.review.leaveOut')}
        </Button>
      </div>
    </li>
  );
}
