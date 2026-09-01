import { useEffect, useMemo, useState } from 'react';
import { AlertIcon, Button, RefreshIcon, useLocale } from '@localcast/ui-kit';
import type { PrerequisiteId } from '../../shared/preflight.js';
import { usePreflightText } from './copy.js';
import { PrerequisiteCard } from './PrerequisiteCard.js';
import { inSeverityOrder, isOutstanding, isSettling, usePreflight } from './usePreflight.js';
import styles from './PreflightStep.module.css';

/**
 * The screen before the wizard's step one: what LocalCast needs and does not have.
 *
 * It exists because of the failure it replaces — a wizard that opens onto a folder picker
 * while the piece that does the actual work is not on the disk, and only says so later, as a
 * print job that never arrives. So this is shown **first**, in plain words, with the fix
 * attached to it.
 *
 * It is also invisible whenever it has nothing to say. `allSatisfied` means the user never
 * learns this screen exists, and neither a bridge that is not there yet nor a check that
 * threw is allowed to trap anyone: both offer a way onwards. The only thing that legitimately
 * stops the wizard is a `blocking` prerequisite the report actually reported.
 */
export function PreflightStep({ onDone }: { onDone: () => void }) {
  const { dir } = useLocale();
  const { c } = usePreflightText();
  const controller = usePreflight();
  const { report, phase, error, busyId, attempts } = controller;
  const [rechecking, setRechecking] = useState(false);
  /**
   * The degrading items the user has chosen to live without. Kept per item rather than as one
   * global "skip": «ادامه بدون این» is a promise about *this* feature, and with two such items
   * on screen a single flag would quietly accept both.
   */
  const [accepted, setAccepted] = useState<PrerequisiteId[]>([]);

  const items = useMemo(() => (report ? inSeverityOrder(report.items) : []), [report]);
  const outstanding = items.filter(isOutstanding);
  const settling = items.some(isSettling);

  const cleared =
    phase === 'unavailable' ||
    (phase === 'ready' &&
      report !== null &&
      (report.allSatisfied ||
        // `canProceed` is the contract's own gate and it wins: if the report says something
        // blocking is outstanding, no amount of local acceptance moves the wizard on.
        (report.canProceed &&
          !settling &&
          outstanding.every((item) => accepted.includes(item.id)))));

  useEffect(() => {
    if (cleared) onDone();
  }, [cleared, onDone]);

  // Nothing is drawn until the first report lands. A screen that flashes into view and out
  // again on every launch is worse than a beat of nothing on the launches where all is well.
  if (phase === 'checking' || cleared) return null;

  if (phase === 'error') {
    return (
      <section className={styles.step} dir={dir}>
        <span className={styles.icon}>
          <AlertIcon size={26} />
        </span>
        <h1 className={styles.title}>{c('preflight.checkFailed')}</h1>
        <p className={styles.lede}>{c('preflight.lede')}</p>
        {error ? (
          <details className={styles.disclosure}>
            <summary className={styles.summary}>{c('preflight.details')}</summary>
            <p className={styles.hint}>{error}</p>
          </details>
        ) : null}
        <div className={styles.footer}>
          <Button variant="primary" onClick={() => void controller.recheck(true)}>
            {c('preflight.recheck')}
          </Button>
          {/* A check that cannot run is not evidence that anything is missing. */}
          <Button variant="ghost" onClick={onDone}>
            {c('preflight.skipCheck')}
          </Button>
        </div>
      </section>
    );
  }

  const runRecheck = async () => {
    setRechecking(true);
    try {
      // Forced: the user pressed this because they just put a file where we said we looked.
      await controller.recheck(true);
    } finally {
      setRechecking(false);
    }
  };

  return (
    <section className={styles.step} dir={dir}>
      <span className={styles.icon}>
        <AlertIcon size={26} />
      </span>
      <h1 className={styles.title}>{c('preflight.title')}</h1>
      <p className={styles.lede}>{c('preflight.lede')}</p>

      <ul className={styles.list}>
        {items.map((item) => (
          <PrerequisiteCard
            key={item.id}
            item={item}
            attempt={attempts[item.id] ?? null}
            busy={busyId === item.id}
            controller={controller}
            onContinueWithout={
              // Offered only where it is true: a degrading item, with nothing blocking left.
              item.severity === 'degrading' && isOutstanding(item) && report?.canProceed
                ? () => setAccepted((current) => [...current, item.id])
                : undefined
            }
          />
        ))}
      </ul>

      <div className={styles.footer}>
        <Button
          variant="secondary"
          size="sm"
          startIcon={<RefreshIcon size={16} />}
          loading={rechecking}
          onClick={() => void runRecheck()}
        >
          {c('preflight.recheck')}
        </Button>
      </div>
    </section>
  );
}
