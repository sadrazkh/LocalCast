import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils/cx.js';
import { useDomId } from '../utils/useId.js';
import styles from './Panel.module.css';

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  /** Trailing controls in the header bar. */
  actions?: ReactNode;
  /** Leading content in the footer, before the trailing action group. */
  footerStart?: ReactNode;
  footer?: ReactNode;
  /** Removes body padding, for a panel whose body is a full-bleed table or list. */
  flush?: boolean;
  /** Makes the body the scrolling region, keeping header and footer pinned. */
  scrollBody?: boolean;
  children: ReactNode;
}

/**
 * The framed region the canvas uses for a settings group or a list: 12px radius, a raised
 * header bar with a rule under it, and an optional footer for the action row.
 *
 * Rendered as a `<section>` labelled by its own title, so the panel appears as a landmark
 * and a screen-reader user can jump between «پوشه‌های اشتراکی» and «دستگاه‌ها» directly.
 */
export function Panel({
  title,
  description,
  actions,
  footer,
  footerStart,
  flush = false,
  scrollBody = false,
  className,
  children,
  ...rest
}: PanelProps) {
  const headingId = useDomId('lc-panel');

  return (
    <section
      className={cx(styles.panel, className)}
      aria-labelledby={title ? headingId : undefined}
      {...rest}
    >
      {title || actions ? (
        <header className={styles.header}>
          <div className={styles.titleGroup}>
            {title ? (
              <h2 className={styles.title} id={headingId}>
                {title}
              </h2>
            ) : null}
            {description ? <span className={styles.description}>{description}</span> : null}
          </div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </header>
      ) : null}

      <div
        className={cx(
          styles.body,
          flush ? styles.bodyFlush : undefined,
          scrollBody ? styles.scroll : undefined,
        )}
      >
        {children}
      </div>

      {footer || footerStart ? (
        <footer className={styles.footer}>
          {footerStart ? <div className={styles.footerStart}>{footerStart}</div> : null}
          {footer ? <div className={styles.footerActions}>{footer}</div> : null}
        </footer>
      ) : null}
    </section>
  );
}
