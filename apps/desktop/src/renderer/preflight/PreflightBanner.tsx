import { useState } from 'react';
import { Button, InfoIcon, useLocale } from '@localcast/ui-kit';
import { usePreflightText } from './copy.js';
import { PrerequisiteCard } from './PrerequisiteCard.js';
import { isOutstanding, usePreflight } from './usePreflight.js';
import styles from './PreflightBanner.module.css';

/**
 * The way back.
 *
 * Someone who pressed «ادامه بدون این» in the wizard made a reasonable choice about one
 * feature, and it must not become a permanent, unexplained absence — a print button that is
 * simply never there. So the panel carries this strip for as long as a `degrading`
 * prerequisite is outstanding: it names the feature that is missing and opens the same
 * remedies the wizard offered, in place, without sending anyone back through setup.
 *
 * It renders nothing at all when there is nothing outstanding, which is the ordinary case.
 * A `blocking` item is deliberately not shown here: the app cannot have reached the panel
 * with one of those still open, and a banner about it would be a puzzle with no answer.
 */
export function PreflightBanner() {
  const { dir, locale } = useLocale();
  const { c, featureOf } = usePreflightText();
  const controller = usePreflight();
  const [open, setOpen] = useState(false);

  const degrading = (controller.report?.items ?? []).filter(
    (item) => item.severity === 'degrading' && isOutstanding(item),
  );

  if (controller.phase !== 'ready' || degrading.length === 0) return null;

  const separator = locale === 'fa' ? '، ' : ', ';
  const features = degrading.map((item) => featureOf(item.id)).join(separator);

  return (
    <section className={styles.banner} dir={dir} role="status">
      <div className={styles.row}>
        <span className={styles.icon}>
          <InfoIcon size={16} />
        </span>
        <p className={styles.text}>{c('preflight.banner.title', { feature: features })}</p>
        <Button variant="secondary" size="sm" onClick={() => setOpen((current) => !current)}>
          {open ? c('preflight.banner.close') : c('preflight.banner.open')}
        </Button>
      </div>

      {open ? (
        <ul className={styles.list}>
          {degrading.map((item) => (
            <PrerequisiteCard
              key={item.id}
              item={item}
              attempt={controller.attempts[item.id] ?? null}
              busy={controller.busyId === item.id}
              controller={controller}
              // No "continue without it" here: the user already did, and this strip is what
              // that decision left behind.
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
