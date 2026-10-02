import type { AuditEntryView } from '@rp/contracts/control-plane';
import { Button, Table, TextField } from '@rp/ui-web';
import { useState } from 'react';
import { when } from '../app/format.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import { useApi } from '../app/services.js';
import { useLoad } from '../app/use-load.js';
import { LoadView } from '../components/LoadView.js';
import { Page } from '../components/Page.js';

const PAGE = 50;
const ACTION = /^[a-z_.]{1,60}$/;
const ID = /^[0-9a-f-]{36}$/i;

/** An entry's details as one line of JSON, for reading at a glance (the full text on hover). */
export function detailsText(details: unknown): string {
  if (details === null || details === undefined) return '';
  return JSON.stringify(details);
}

/**
 * The Control Plane's audit trail (SEC-018): every vendor and CLI action with its actor, newest
 * first, filtered by action or target, fifty at a time.
 */
export function AuditScreen() {
  const t = useT();
  const api = useApi();
  const [action, setAction] = useState('');
  const [target, setTarget] = useState('');
  const [applied, setApplied] = useState<{ action?: string; targetId?: string }>({});
  const [older, setOlder] = useState<AuditEntryView[]>([]);
  const [more, setMore] = useState<'idle' | 'busy' | 'end'>('idle');
  const [error, setError] = useState<string | undefined>();
  const { data, reload } = useLoad(
    (signal) => api.listVendorAudit({ query: { ...applied, limit: PAGE }, signal }),
    `audit:${applied.action ?? ''}:${applied.targetId ?? ''}`,
  );
  const actionError =
    action.trim() !== '' && !ACTION.test(action.trim())
      ? t('vendorApp.audit.actionInvalid')
      : undefined;
  const targetError =
    target.trim() !== '' && !ID.test(target.trim())
      ? t('vendorApp.audit.targetInvalid')
      : undefined;

  return (
    <Page title={t('vendorApp.audit.title')} intro={t('vendorApp.audit.intro')}>
      <form
        className="cp-toolbar"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (actionError !== undefined || targetError !== undefined) return;
          setOlder([]);
          setMore('idle');
          setApplied({
            ...(action.trim() !== '' && { action: action.trim() }),
            ...(target.trim() !== '' && { targetId: target.trim().toLowerCase() }),
          });
        }}
      >
        <TextField
          label={t('vendorApp.audit.action')}
          hint={t('vendorApp.audit.actionHint')}
          value={action}
          error={actionError}
          onChange={(event) => {
            setAction(event.target.value);
          }}
        />
        <TextField
          label={t('vendorApp.audit.target')}
          value={target}
          error={targetError}
          onChange={(event) => {
            setTarget(event.target.value);
          }}
        />
        <Button type="submit" variant="secondary">
          {t('vendorApp.audit.filter')}
        </Button>
      </form>
      <LoadView data={data} reload={reload} failed={t('vendorApp.audit.loadFailed')}>
        {({ entries }) => {
          const rows = [...entries, ...older];
          const last = rows.at(-1);
          return (
            <>
              <Table
                caption={t('vendorApp.audit.title')}
                hideCaption
                rows={rows}
                rowKey={(entry) => entry.id}
                empty={t('vendorApp.audit.empty')}
                columns={[
                  { key: 'at', header: t('vendorApp.audit.at'), cell: (entry) => when(entry.at) },
                  {
                    key: 'actor',
                    header: t('vendorApp.audit.actor'),
                    cell: (entry) => entry.actor,
                  },
                  {
                    key: 'action',
                    header: t('vendorApp.audit.action'),
                    cell: (entry) => entry.action,
                  },
                  {
                    key: 'target',
                    header: t('vendorApp.audit.target'),
                    cell: (entry) =>
                      entry.targetId === null
                        ? entry.targetType
                        : `${entry.targetType} ${entry.targetId}`,
                  },
                  {
                    key: 'details',
                    header: t('vendorApp.audit.details'),
                    cell: (entry) => {
                      const text = detailsText(entry.details);
                      return text === '' ? (
                        '—'
                      ) : (
                        <code className="cp-code" title={text}>
                          {text}
                        </code>
                      );
                    },
                  },
                ]}
              />
              {entries.length < PAGE || more === 'end' || last === undefined ? null : (
                <Button
                  variant="secondary"
                  loading={more === 'busy'}
                  onClick={() => {
                    setMore('busy');
                    setError(undefined);
                    api
                      .listVendorAudit({
                        query: { ...applied, before: Number(last.id), limit: PAGE },
                      })
                      .then(
                        (page) => {
                          setOlder((previous) => [...previous, ...page.entries]);
                          setMore(page.entries.length < PAGE ? 'end' : 'idle');
                        },
                        (failure: unknown) => {
                          setMore('idle');
                          setError(messageOf(failure, t));
                        },
                      );
                  }}
                >
                  {t('vendorApp.audit.older')}
                </Button>
              )}
              {error === undefined ? null : (
                <p role="alert" className="cp-notice cp-notice--danger">
                  {error}
                </p>
              )}
            </>
          );
        }}
      </LoadView>
    </Page>
  );
}
