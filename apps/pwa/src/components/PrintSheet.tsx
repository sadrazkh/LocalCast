import { useEffect, useState } from 'react';
import { Modal, PrintDialog, PrintJobStatus, Spinner, useT } from '@localcast/ui-kit';
import type { Entry, PrintJob, PrintRequest, Printer } from '@localcast/contract';
import { useApi } from '../client/ClientProvider.js';
import { useServerEvent } from '../hooks/useServerEvent.js';
import { useAppT } from '../i18n/messages.js';

/**
 * The print flow, wired.
 *
 * `ui-kit`'s `PrintDialog` owns the form and emits a `PrintRequest` straight from the
 * contract; this component owns the three things a shared component cannot: which printers
 * exist, sending the request, and following the job afterwards.
 *
 * It does not poll. Job state arrives on the same SSE stream that drives the connection dot,
 * which is what makes «انجام‌شده» mean what the spec says it means — that the Windows spooler
 * reported the job finished, not that a POST returned 202.
 */
export interface PrintSheetProps {
  /** The file to print, or `null` when the sheet is closed. */
  entry: Entry | null;
  onClose: () => void;
}

export function PrintSheet({ entry, onClose }: PrintSheetProps) {
  const t = useT();
  const at = useAppT();
  const api = useApi();

  const [printers, setPrinters] = useState<Printer[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<PrintJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = entry !== null;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError(null);
    void api
      .printers({ signal: controller.signal })
      .then(setPrinters)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setPrinters([]);
        setError(messageOf(cause));
      });
    return () => controller.abort();
  }, [api, open]);

  // A new file means a new job. Without this the previous job's «انجام‌شده» would be shown
  // over a document that has not been sent yet.
  useEffect(() => {
    setJob(null);
    setError(null);
    setSubmitting(false);
  }, [entry?.id]);

  useServerEvent('print-job', (event) => {
    setJob((current) => (current !== null && current.id === event.job.id ? event.job : current));
  });

  if (entry === null) return null;

  async function submit(request: PrintRequest): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      setJob(await api.print(request));
    } catch (cause: unknown) {
      setError(messageOf(cause));
    } finally {
      setSubmitting(false);
    }
  }

  // Once the job exists the form is gone: there is nothing left to change, and re-submitting
  // the same document because the dialogue still looked live is a wasted ream of paper.
  if (job !== null) {
    return (
      <Modal open onClose={onClose} title={at('printDialog.jobStatus')} size="sm">
        <div data-testid="print-job-status">
          <PrintJobStatus status={job.status} errorMessage={job.errorMessage} />
        </div>
      </Modal>
    );
  }

  if (printers === null) {
    return (
      <Modal open onClose={onClose} title={at('printDialog.title')} size="sm">
        <Spinner labelled />
      </Modal>
    );
  }

  return (
    <PrintDialog
      open
      onClose={onClose}
      printers={printers}
      // The contract's own discriminated union, built here so the dialogue never has to know
      // whether it is printing a library file or a fresh upload.
      source={{ kind: 'library', fileId: entry.id }}
      fileName={entry.name}
      submitting={submitting}
      error={error ?? (entry.printable ? undefined : t('print.unprintable'))}
      onSubmit={(request) => void submit(request)}
    />
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
