import type { Tone } from '@rp/design-tokens';
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useUiStrings } from '../strings.js';
import { Icon, type IconName } from './Icon.js';
import { IconButton } from './IconButton.js';

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: Tone;
  /**
   * Milliseconds before it hides itself; `null` keeps it until dismissed. Defaults to the
   * provider's duration, except `danger` toasts, which stay until dismissed.
   */
  duration?: number | null;
  action?: { label: string; onAction: () => void };
}

interface ToastRecord extends ToastOptions {
  readonly id: string;
}

export interface ToastApi {
  /** Shows a toast and returns its id. */
  show: (toast: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export const TONE_ICONS: Readonly<Record<Tone, IconName>> = {
  neutral: 'info',
  info: 'info',
  success: 'check',
  warning: 'warning',
  danger: 'error',
};

export interface ToastProviderProps {
  children: ReactNode;
  /** Auto-hide delay for non-error toasts, in milliseconds. */
  duration?: number;
  /** Oldest toasts are dropped beyond this many. */
  max?: number;
}

/**
 * Short, non-blocking messages. Errors use `role="alert"` and stay until dismissed; others are
 * polite status messages that pause while hovered or focused (WCAG 2.2.1).
 */
export function ToastProvider({ children, duration = 5000, max = 4 }: ToastProviderProps) {
  const strings = useUiStrings().toast;
  const [toasts, setToasts] = useState<readonly ToastRecord[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (toast: ToastOptions) => {
      nextId.current += 1;
      const id = `toast-${String(nextId.current)}`;
      setToasts((current) => [...current, { ...toast, id }].slice(-max));
      return id;
    },
    [max],
  );

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext value={api}>
      {children}
      <section aria-label={strings.region} className="rp-toast-region">
        {toasts.map((toast) => (
          <ToastItem
            key={toast.id}
            toast={toast}
            defaultDuration={duration}
            dismissLabel={strings.dismiss}
            onDismiss={dismiss}
          />
        ))}
      </section>
    </ToastContext>
  );
}

function ToastItem({
  toast,
  defaultDuration,
  dismissLabel,
  onDismiss,
}: {
  toast: ToastRecord;
  defaultDuration: number;
  dismissLabel: string;
  onDismiss: (id: string) => void;
}) {
  const tone = toast.tone ?? 'info';
  const duration =
    toast.duration !== undefined ? toast.duration : tone === 'danger' ? null : defaultDuration;
  const [paused, setPaused] = useState(false);
  const remaining = useRef(duration ?? 0);
  const { id } = toast;

  useEffect(() => {
    if (duration === null || paused) return;
    const started = Date.now();
    const timer = setTimeout(() => {
      onDismiss(id);
    }, remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [duration, paused, id, onDismiss]);

  const pause = () => {
    setPaused(true);
  };
  const resume = () => {
    setPaused(false);
  };

  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      data-tone={tone}
      className="rp-toast"
      onPointerEnter={pause}
      onPointerLeave={resume}
      onFocus={pause}
      onBlur={resume}
    >
      <Icon name={TONE_ICONS[tone]} className="rp-toast__icon" />
      <div className="rp-toast__content">
        <p className="rp-toast__title">{toast.title}</p>
        {toast.description ? <p className="rp-toast__description">{toast.description}</p> : null}
      </div>
      {toast.action ? (
        <button
          type="button"
          className="rp-toast__action"
          onClick={() => {
            toast.action?.onAction();
            onDismiss(id);
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <IconButton
        label={dismissLabel}
        icon={<Icon name="close" />}
        onClick={() => {
          onDismiss(id);
        }}
        className="rp-toast__dismiss"
      />
    </div>
  );
}

export function useToast(): ToastApi {
  const api = use(ToastContext);
  if (!api) throw new Error('useToast needs a <ToastProvider> above it.');
  return api;
}
