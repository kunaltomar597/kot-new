import type { IsoDate } from '@rp/domain';
import { Button, TextField } from '@rp/ui-web';
import { useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import {
  checkRange,
  presetOf,
  presetRange,
  RANGE_PRESETS,
  type ReportRange,
} from './report-view.js';

/**
 * The period every report (and the audit viewer) reads (RPT-016): presets in one row, or two
 * dates. Give it a `key` of the range so a new range starts the form again.
 */
export function RangeFilter({
  range,
  today,
  onChange,
}: {
  range: ReportRange;
  today: IsoDate;
  onChange: (range: ReportRange) => void;
}) {
  const t = useT();
  const formId = useId();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [problem, setProblem] = useState<string | undefined>();
  const current = presetOf(range, today);
  return (
    <div className="report-filters" role="group" aria-label={t('reportsPage.range.label')}>
      <div className="report-filters__presets">
        {RANGE_PRESETS.map((preset) => (
          <Button
            key={preset}
            variant={current === preset ? 'primary' : 'secondary'}
            aria-pressed={current === preset}
            onClick={() => {
              setProblem(undefined);
              onChange(presetRange(preset, today));
            }}
          >
            {t(`reportsPage.range.${preset}`)}
          </Button>
        ))}
      </div>
      <form
        id={formId}
        className="report-filters__custom"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const wanted = { from, to };
          const issue = checkRange(wanted);
          if (issue !== undefined) {
            setProblem(t(`reportsPage.range.problems.${issue}`));
            return;
          }
          setProblem(undefined);
          onChange(wanted);
        }}
      >
        <TextField
          label={t('reportsPage.range.from')}
          type="date"
          value={from}
          onChange={(event) => {
            setFrom(event.target.value);
          }}
        />
        <TextField
          label={t('reportsPage.range.to')}
          type="date"
          value={to}
          error={problem}
          onChange={(event) => {
            setTo(event.target.value);
          }}
        />
        <Button type="submit" variant="secondary">
          {t('reportsPage.range.show')}
        </Button>
      </form>
    </div>
  );
}
