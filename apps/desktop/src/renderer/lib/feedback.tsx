import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Modal, Toast, ToastViewport, useT } from '@localcast/ui-kit';
import type { ToastTone } from '@localcast/ui-kit';
import { useCopy } from './copy.js';

/**
 * The two pieces of ephemeral UI the panel needs at its root: a confirmation dialogue and a
 * toast stack.
 *
 * Confirmation is a promise rather than a callback prop so a destructive handler reads as
 * one linear function — `if (!(await confirm(...))) return;` — instead of being split across
 * an `onConfirm` that has forgotten which row it was about. Every revoke and every removal
 * in this app goes through it; none of them fire on a single click.
 */

export interface ConfirmOptions {
  title?: ReactNode;
  body: ReactNode;
  confirmLabel?: ReactNode;
  /** Paints the confirm button as destructive. Used for revoke and for removing a folder. */
  danger?: boolean;
}

export interface ToastRequest {
  tone?: ToastTone;
  title: ReactNode;
  description?: ReactNode;
}

interface FeedbackValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  toast: (request: ToastRequest) => void;
}

const FeedbackContext = createContext<FeedbackValue>({
  confirm: () => Promise.resolve(false),
  toast: () => undefined,
});

interface OpenConfirm extends ConfirmOptions {
  resolve: (accepted: boolean) => void;
}

interface LiveToast extends ToastRequest {
  id: number;
}

const TOAST_MS = 6_000;

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const c = useCopy();
  const [pending, setPending] = useState<OpenConfirm | null>(null);
  const [toasts, setToasts] = useState<LiveToast[]>([]);
  const nextId = useRef(1);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending({ ...options, resolve });
      }),
    [],
  );

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const toast = useCallback(
    (request: ToastRequest) => {
      const id = nextId.current++;
      setToasts((current) => [...current, { ...request, id }]);
      // Auto-dismiss, but the toast also carries a close button: an operator reading a long
      // error message should not have it vanish mid-sentence, and they can dismiss it early.
      window.setTimeout(() => dismiss(id), TOAST_MS);
    },
    [dismiss],
  );

  const value = useMemo<FeedbackValue>(() => ({ confirm, toast }), [confirm, toast]);

  const close = (accepted: boolean) => {
    pending?.resolve(accepted);
    setPending(null);
  };

  return (
    <FeedbackContext.Provider value={value}>
      {children}

      <Modal
        open={pending !== null}
        onClose={() => close(false)}
        title={pending?.title ?? c('confirm.title')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant={pending?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
              {pending?.confirmLabel ?? t('common.confirm')}
            </Button>
          </>
        }
      >
        {pending?.body}
      </Modal>

      {toasts.length > 0 ? (
        <ToastViewport>
          {toasts.map((entry) => (
            <Toast
              key={entry.id}
              tone={entry.tone ?? 'info'}
              title={entry.title}
              description={entry.description}
              onDismiss={() => dismiss(entry.id)}
            />
          ))}
        </ToastViewport>
      ) : null}
    </FeedbackContext.Provider>
  );
}

export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  return useContext(FeedbackContext).confirm;
}

export function useToast(): (request: ToastRequest) => void {
  return useContext(FeedbackContext).toast;
}
