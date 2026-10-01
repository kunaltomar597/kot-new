'use client';

import type { QrServiceRequestType, QrServiceRequestView } from '@rp/contracts/relay';
import { Button } from '@rp/ui-web';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useT } from './i18n';
import { fetchServiceRequest, raiseServiceRequest } from './relay';
import { browserId, newUuid, tableValue } from './storage';

const TYPES: readonly QrServiceRequestType[] = ['WAITER', 'BILL'];
const NO_IDS: readonly string[] = [];
const POLL_MS = 3_000;
const SETTLED = new Set(['DONE', 'REJECTED', 'EXPIRED']);

/**
 * Call waiter and Request bill from the QR page (QR-011), for tables without a tablet: the same
 * service requests as the tablet's, with "Waiter notified" and "Waiter is on the way" as the
 * restaurant answers. Pressing again while one is open finds the open one.
 */
export function HelpButtons({
  token,
  relayUrl,
  readOnly,
}: {
  token: string;
  relayUrl: string;
  readOnly: boolean;
}) {
  const t = useT();
  const stored = useMemo(
    () =>
      tableValue<readonly string[]>(
        token,
        'requests',
        (value) =>
          Array.isArray(value)
            ? value.filter((id): id is string => typeof id === 'string')
            : undefined,
        NO_IDS,
      ),
    [token],
  );
  const ids = useSyncExternalStore(stored.subscribe, stored.get, () => stored.empty);
  const [requests, setRequests] = useState<ReadonlyMap<string, QrServiceRequestView>>(new Map());
  const [busy, setBusy] = useState<QrServiceRequestType | undefined>();
  const [failed, setFailed] = useState(false);

  const unsettled = ids
    .filter((id) => {
      const request = requests.get(id);
      return request === undefined || !SETTLED.has(request.status);
    })
    .join(',');
  useEffect(() => {
    if (unsettled === '') return;
    let stopped = false;
    const poll = () => {
      for (const id of unsettled.split(',')) {
        fetchServiceRequest(relayUrl, token, id).then(
          (request) => {
            if (!stopped) setRequests((current) => new Map([...current, [id, request]]));
          },
          () => undefined,
        );
      }
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [relayUrl, token, unsettled]);

  const ask = (type: QrServiceRequestType) => {
    setBusy(type);
    setFailed(false);
    raiseServiceRequest(relayUrl, token, browserId(), type, newUuid()).then(
      ({ request }) => {
        setBusy(undefined);
        setRequests((current) => new Map([...current, [request.id, request]]));
        stored.set([request.id, ...ids.filter((id) => id !== request.id)].slice(0, 10));
      },
      () => {
        setBusy(undefined);
        setFailed(true);
      },
    );
  };

  // The latest of each kind.
  const latest = TYPES.flatMap((type) => {
    const request = ids.map((id) => requests.get(id)).find((entry) => entry?.type === type);
    return request === undefined ? [] : [request];
  });
  return (
    <section className="qr-help" aria-labelledby="qr-help-title">
      <h2 id="qr-help-title" className="qr-section__title">
        {t('qrSite.help.title')}
      </h2>
      <div className="qr-help__buttons">
        {TYPES.map((type) => (
          <Button
            key={type}
            variant="secondary"
            loading={busy === type}
            disabled={readOnly || busy !== undefined}
            onClick={() => {
              ask(type);
            }}
          >
            {t(`qrSite.help.${type}`)}
          </Button>
        ))}
      </div>
      {latest.map((request) => (
        <p key={request.id} role="status" className="qr-help__status">
          {t('qrSite.help.line', {
            what: t(`qrSite.help.${request.type}`),
            status: t(`qrSite.help.status.${request.status}`, {
              reason: request.rejectionReason ?? '',
            }),
          })}
        </p>
      ))}
      {failed ? (
        <p role="alert" className="qr-notice qr-notice--danger">
          {t('qrSite.help.failed')}
        </p>
      ) : null}
    </section>
  );
}
