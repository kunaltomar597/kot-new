import { ErrorState, LoadingState } from '@rp/ui-web';
import type { ReactNode } from 'react';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';
import type { Loaded } from '../app/use-load.js';

/** Loading, a failure with "Try again", or the content. */
export function LoadView<T>({
  data,
  reload,
  failed,
  children,
}: {
  data: Loaded<T>;
  reload: () => void;
  failed: string;
  children: (value: T) => ReactNode;
}) {
  const t = useT();
  if (data.status === 'loading') return <LoadingState title={t('states.loading')} />;
  if (data.status === 'error') {
    return (
      <ErrorState
        title={failed}
        description={messageOf(data.error, t)}
        onRetry={reload}
        retryLabel={t('states.retry')}
      />
    );
  }
  return <>{children(data.value)}</>;
}
