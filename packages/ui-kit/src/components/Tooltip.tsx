import { cloneElement, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { cx } from '../utils/cx.js';
import { useDomId } from '../utils/useId.js';
import styles from './Tooltip.module.css';

export interface TooltipProps {
  content: ReactNode;
  placement?: 'top' | 'bottom';
  /** The trigger. Must be focusable — a `<button>`, not a `<span>`. */
  children: ReactElement;
  className?: string;
  /** Renders the tooltip open regardless of pointer state; for tests and for debugging. */
  open?: boolean;
}

/**
 * A hover/focus tooltip.
 *
 * It opens on focus as well as hover, and closes on Escape, so a keyboard user gets the same
 * information a mouse user does. It is `role="tooltip"` wired with `aria-describedby`, which
 * means the trigger must have its own accessible name — a tooltip is never the only label
 * on a control.
 */
export function Tooltip({ content, placement = 'top', children, className, open }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const tooltipId = useDomId('lc-tooltip');
  const shown = open ?? visible;

  return (
    <span
      className={cx(styles.wrapper, className)}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocusCapture={() => setVisible(true)}
      onBlurCapture={() => setVisible(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setVisible(false);
      }}
    >
      {/*
        `aria-describedby` goes onto the trigger itself, not onto a wrapper. A description
        on a wrapping <span> associates with nothing — the button would announce its name
        and no description at all, which is the failure mode this component exists to avoid.
      */}
      {cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, {
        'aria-describedby': shown ? tooltipId : undefined,
      })}
      {shown ? (
        <span className={cx(styles.layer, styles[placement])}>
          <span className={styles.bubble} role="tooltip" id={tooltipId}>
            {content}
          </span>
        </span>
      ) : null}
    </span>
  );
}
