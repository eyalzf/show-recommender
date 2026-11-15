/**
 * Pure toast-list logic for the single app-wide notification system.
 * Kept free of React so the self-test can exercise it directly: the
 * React provider in components/Notifications.tsx is a thin shell over
 * these helpers. One list, one placement, every screen.
 */

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  /** Stable id: the dedupe key when one was given, else a generated id. */
  id: string;
  message: string;
  kind: ToastKind;
  /** Sticky toasts never auto-dismiss (errors, in-progress states). */
  sticky: boolean;
  action?: ToastAction;
}

export interface NewToast {
  message: string;
  kind?: ToastKind;
  sticky?: boolean;
  action?: ToastAction;
  /**
   * Dedupe key: a new toast with the same key REPLACES the existing one
   * (no duplicates for repeated failures or re-renders). The key is
   * also the toast's id, so dismiss(key) removes it.
   */
  key?: string;
}

/** Max toasts on screen at once; the oldest non-sticky toast goes first. */
export const MAX_TOASTS = 4;

/**
 * Add a toast: replace by key when one matches, else append (evicting
 * the oldest non-sticky toast past the cap; sticky toasts are only
 * evicted when every visible toast is sticky).
 */
export function addToast(list: Toast[], next: NewToast, fallbackId: string): Toast[] {
  const toast: Toast = {
    id: next.key ?? fallbackId,
    message: next.message,
    kind: next.kind ?? 'info',
    sticky: next.sticky ?? false,
    action: next.action,
  };
  const existing = next.key == null ? -1 : list.findIndex((t) => t.id === next.key);
  const replaced =
    existing >= 0 ? list.map((t, i) => (i === existing ? toast : t)) : [...list, toast];
  if (replaced.length <= MAX_TOASTS) return replaced;
  const evict = replaced.findIndex((t) => !t.sticky);
  const dropAt = evict >= 0 ? evict : 0;
  return replaced.filter((_, i) => i !== dropAt);
}

/** Remove one toast by id (or by key — keys are ids). */
export function dismissToast(list: Toast[], id: string): Toast[] {
  return list.filter((t) => t.id !== id);
}
