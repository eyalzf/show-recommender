import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { addToast, dismissToast, type NewToast, type Toast } from '../toastList';
import type { UiLang } from '../types';
import { t } from '../i18n';

export type NotifyFn = (message: string, opts?: Omit<NewToast, 'message'>) => string;
export type DismissFn = (id: string) => void;

export interface NotifyApi {
  notify: NotifyFn;
  dismiss: DismissFn;
}

const NotifyContext = createContext<NotifyApi>({
  notify: () => '',
  dismiss: () => {},
});

/**
 * The one way to show a transient message anywhere in the app. `notify`
 * returns the toast id (the dedupe key when one was given); `dismiss`
 * removes a toast by id — used to retire sticky progress toasts when
 * the work they describe finishes.
 */
export function useNotify(): NotifyApi {
  return useContext(NotifyContext);
}

/** How long a non-sticky toast stays on screen. */
const AUTO_DISMISS_MS = 4500;

export function NotificationProvider({
  lang,
  children,
}: {
  lang: UiLang;
  children: ReactNode;
}) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, number>());
  const seq = useRef(0);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer != null) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => dismissToast(prev, id));
  }, []);

  const notify = useCallback(
    (message: string, opts?: Omit<NewToast, 'message'>): string => {
      const id = opts?.key ?? `toast-${++seq.current}`;
      // Replacing a keyed toast restarts its auto-dismiss clock.
      const oldTimer = timers.current.get(id);
      if (oldTimer != null) {
        window.clearTimeout(oldTimer);
        timers.current.delete(id);
      }
      setToasts((prev) => addToast(prev, { ...opts, message }, id));
      if (!opts?.sticky) {
        timers.current.set(
          id,
          window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS),
        );
      }
      return id;
    },
    [dismiss],
  );

  return (
    <NotifyContext.Provider value={{ notify, dismiss }}>
      {children}
      <div className="toast-viewport" aria-live="polite" aria-label={t(lang, 'notificationsLabel')}>
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.kind}`} role="status">
            <span className="toast-message">{toast.message}</span>
            {toast.action ? (
              <button
                type="button"
                className="btn btn-sm toast-action"
                onClick={() => {
                  toast.action!.onClick();
                  dismiss(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            ) : null}
            <button
              type="button"
              className="toast-close"
              aria-label={t(lang, 'close')}
              onClick={() => dismiss(toast.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </NotifyContext.Provider>
  );
}
