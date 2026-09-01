import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { PrintRequest, Printer } from '@localcast/contract';
import { toAsciiDigits } from '../i18n/format.js';
import { useT } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import { PrinterIcon } from '../icons/index.js';
import { Button } from './Button.js';
import { Input } from './Input.js';
import { Modal } from './Modal.js';
import { RadioGroup } from './Radio.js';
import { Select } from './Select.js';
import styles from './PrintDialog.module.css';

export interface PrintDialogProps {
  open: boolean;
  onClose: () => void;
  printers: readonly Printer[];
  /** What is being printed. Passed straight through into the emitted `PrintRequest`. */
  source: PrintRequest['source'];
  /** Shown at the top so the operator can see what they are about to spend paper on. */
  fileName?: string;
  onSubmit: (request: PrintRequest) => void;
  submitting?: boolean;
  /** Server-side failure, e.g. `unprintable_type` translated by the caller. */
  error?: ReactNode;
  className?: string;
}

/**
 * The print sheet: printer, copies, colour, duplex, page range.
 *
 * Submit stays disabled until a printer is chosen. There is no "default printer"
 * pre-selection: `Get-Printer` reports a Windows default that is frequently a PDF writer or
 * a disconnected office device, and silently pre-selecting it means an operator who taps
 * straight through prints to the wrong place. The default is offered as a note on the
 * option instead.
 *
 * The emitted object is exactly `PrintRequest` from the contract — `pageRange` is omitted
 * rather than sent as an empty string, because the schema marks it optional and the server
 * reads "absent" as "every page".
 */
export function PrintDialog({
  open,
  onClose,
  printers,
  source,
  fileName,
  onSubmit,
  submitting = false,
  error,
  className,
}: PrintDialogProps) {
  const t = useT();

  const [printerId, setPrinterId] = useState('');
  const [copies, setCopies] = useState('1');
  const [color, setColor] = useState<'color' | 'mono'>('mono');
  const [duplex, setDuplex] = useState<'simplex' | 'long' | 'short'>('simplex');
  const [pageRange, setPageRange] = useState('');

  const printer = printers.find((candidate) => candidate.id === printerId) ?? null;

  const printerOptions = useMemo(
    () =>
      printers.map((candidate) => ({
        value: candidate.id,
        label: candidate.name,
        note: !candidate.online
          ? t('print.printerOffline')
          : candidate.isDefault
            ? t('print.printerDefault')
            : undefined,
        disabled: !candidate.online,
      })),
    [printers, t],
  );

  // A Persian keyboard produces «۲»; the server wants 2. Normalising on the way in is the
  // same rule `formatCode` applies to pairing codes.
  const copiesNumber = Number.parseInt(toAsciiDigits(copies), 10);
  const copiesValid = Number.isFinite(copiesNumber) && copiesNumber >= 1 && copiesNumber <= 99;

  const canSubmit = printerId !== '' && copiesValid && !submitting;

  const submit = () => {
    if (!canSubmit) return;
    const request: PrintRequest = {
      printerId,
      source,
      copies: copiesNumber,
      color,
      duplex,
      ...(pageRange.trim() ? { pageRange: toAsciiDigits(pageRange).trim() } : {}),
    };
    onSubmit(request);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('print.title')}
      size="md"
      className={className}
      footerStart={
        canSubmit ? null : <span className={styles.blockedNote}>{t('print.choosePrinter')}</span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit} loading={submitting}>
            {t('print.submit')}
          </Button>
        </>
      }
    >
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {fileName ? (
          <div className={styles.fileName}>
            <PrinterIcon size={16} />
            <span className={styles.fileNameText} title={fileName}>
              {fileName}
            </span>
          </div>
        ) : null}

        <Select
          label={t('print.printer')}
          placeholder={t('print.choosePrinter')}
          options={printerOptions}
          value={printerId}
          error={error}
          required
          onChange={(event) => setPrinterId(event.target.value)}
        />

        <div className={styles.grid}>
          <Input
            label={t('print.copies')}
            inputMode="numeric"
            latin
            value={copies}
            className={styles.copies}
            error={copies !== '' && !copiesValid ? t('common.required') : undefined}
            onChange={(event) => setCopies(event.target.value)}
          />

          <Input
            label={t('print.pageRange')}
            placeholder={t('print.pageRangePlaceholder')}
            hint={t('print.pageRangeHint')}
            latin
            optional
            value={pageRange}
            onChange={(event) => setPageRange(event.target.value)}
          />

          <RadioGroup<'color' | 'mono'>
            className={styles.span}
            name="lc-print-color"
            label={t('print.color')}
            horizontal
            value={color}
            onChange={setColor}
            options={[
              {
                value: 'color',
                label: t('print.colorColor'),
                // A mono-only printer would silently render colour as grey; saying so up
                // front is better than a job that comes out looking wrong.
                disabled: printer !== null && !printer.colorCapable,
              },
              { value: 'mono', label: t('print.colorMono') },
            ]}
          />

          <Select
            fieldClassName={styles.span}
            label={t('print.duplex')}
            value={duplex}
            onChange={(event) => setDuplex(event.target.value as 'simplex' | 'long' | 'short')}
            options={[
              { value: 'simplex', label: t('print.duplexSimplex') },
              {
                value: 'long',
                label: t('print.duplexLong'),
                disabled: printer !== null && !printer.duplexCapable,
              },
              {
                value: 'short',
                label: t('print.duplexShort'),
                disabled: printer !== null && !printer.duplexCapable,
              },
            ]}
          />
        </div>

        {/*
          Enter inside a text field only triggers implicit submission when the form contains
          a submit control, and the visible one lives in the modal footer outside the form.
          This stand-in is hidden from assistive tech and out of the tab order, so it is not
          a second «ارسال به چاپ» for anyone to find.
        */}
        <button
          type="submit"
          className="lc-sr-only"
          tabIndex={-1}
          aria-hidden="true"
          disabled={!canSubmit}
        >
          {t('print.submit')}
        </button>
      </form>
    </Modal>
  );
}
