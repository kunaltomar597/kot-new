import type { BillView, SplitBillRequest } from '@rp/contracts';
import { Button, Dialog, QuantityStepper, Select, Tabs } from '@rp/ui-web';
import { useId, useState } from 'react';
import { useT } from '../app/i18n.js';
import { itemsSplit } from './split.js';

/**
 * Splitting a bill (BILL-007, NFR-U06): equally into 2 to 20 parts, or by giving each item to a
 * part. Each part is issued and printed as its own invoice.
 */
export function SplitDialog({
  bill,
  onSplit,
  onClose,
  busy,
  error,
}: {
  bill: BillView;
  onSplit: (request: SplitBillRequest) => void;
  onClose: () => void;
  busy: boolean;
  error: string | undefined;
}) {
  const t = useT();
  const formId = useId();
  const [mode, setMode] = useState<'EQUAL' | 'ITEMS'>('EQUAL');
  const [parts, setParts] = useState(2);
  const [assignment, setAssignment] = useState<Record<string, number | undefined>>({});
  const [problem, setProblem] = useState<string | undefined>();
  const partCount = Math.max(2, parts);

  const submit = () => {
    if (mode === 'EQUAL') {
      onSplit({ mode: 'EQUAL', parts, seriesId: null });
      return;
    }
    const result = itemsSplit(bill, assignment);
    if (!result.ok) {
      setProblem(
        result.problem === 'UNASSIGNED'
          ? t('billing.split.unassigned')
          : t('billing.split.needTwo'),
      );
      return;
    }
    setProblem(undefined);
    onSplit(result.request);
  };

  const partsStepper = (
    <QuantityStepper
      value={parts}
      min={2}
      max={20}
      onChange={setParts}
      label={t('billing.split.parts')}
      decreaseLabel={t('pos.item.fewer')}
      increaseLabel={t('pos.item.more')}
    />
  );

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      dismissible={!busy}
      title={t('billing.split.title')}
      footer={
        <Button type="submit" form={formId} loading={busy}>
          {t('billing.split.submit')}
        </Button>
      }
    >
      <form
        id={formId}
        className="console-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {error === undefined && problem === undefined ? null : (
          <p role="alert" className="console-notice console-notice--danger">
            {problem ?? error}
          </p>
        )}
        <Tabs
          label={t('billing.split.mode')}
          value={mode}
          onValueChange={(value) => {
            setMode(value === 'ITEMS' ? 'ITEMS' : 'EQUAL');
            setProblem(undefined);
          }}
          items={[
            { id: 'EQUAL', label: t('billing.split.equal'), content: partsStepper },
            {
              id: 'ITEMS',
              label: t('billing.split.items'),
              content: (
                <div className="console-form">
                  {partsStepper}
                  {bill.lines.map((line) => (
                    <Select
                      key={line.orderItemId}
                      label={t('billing.split.partOf', {
                        item: `${String(line.quantity)} × ${line.description}`,
                      })}
                      value={
                        assignment[line.orderItemId] === undefined
                          ? ''
                          : String(assignment[line.orderItemId])
                      }
                      placeholder="—"
                      options={Array.from({ length: partCount }, (_, index) => ({
                        value: String(index + 1),
                        label: t('billing.split.part', { number: index + 1 }),
                      }))}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        setAssignment({
                          ...assignment,
                          [line.orderItemId]:
                            Number.isInteger(value) && value > 0 ? value : undefined,
                        });
                      }}
                    />
                  ))}
                </div>
              ),
            },
          ]}
        />
      </form>
    </Dialog>
  );
}
