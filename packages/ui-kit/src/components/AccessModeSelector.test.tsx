import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AccessMode } from '@localcast/contract';
import { LocaleProvider } from '../i18n/index.js';
import type { Locale } from '../i18n/index.js';
import { AccessModeSelector } from './AccessModeSelector.js';

/**
 * The component is controlled, so a sequence of key presses needs something holding the
 * value between them; a static `value` would make every arrow press start from `full`.
 */
function Harness({
  locale,
  initial = 'full',
  onChange,
}: {
  locale: Locale;
  initial?: AccessMode;
  onChange?: (mode: AccessMode) => void;
}) {
  const [mode, setMode] = useState<AccessMode>(initial);
  return (
    <LocaleProvider locale={locale}>
      <AccessModeSelector
        value={mode}
        onChange={(next) => {
          setMode(next);
          onChange?.(next);
        }}
      />
    </LocaleProvider>
  );
}

const label = (locale: Locale, mode: AccessMode) => {
  const fa: Record<AccessMode, string> = { full: 'کامل', stream: 'فقط پخش', none: 'بسته' };
  const en: Record<AccessMode, string> = { full: 'Full', stream: 'Stream only', none: 'Closed' };
  return locale === 'fa' ? fa[mode] : en[mode];
};

describe('AccessModeSelector', () => {
  it('exposes the three modes as a radiogroup', () => {
    render(<Harness locale="fa" />);
    const group = screen.getByRole('radiogroup', { name: 'حالت دسترسی' });
    expect(group).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: 'کامل' }).getAttribute('aria-checked')).toBe('true');
  });

  it('keeps exactly one segment in the tab order', () => {
    render(<Harness locale="fa" initial="stream" />);
    const inOrder = screen
      .getAllByRole('radio')
      .filter((node) => node.getAttribute('tabindex') === '0');
    expect(inOrder).toHaveLength(1);
    expect(inOrder[0]?.textContent).toBe('فقط پخش');
  });

  it('moves forward with ArrowLeft under RTL, because "next" is physically left in Persian', () => {
    const onChange = vi.fn();
    render(<Harness locale="fa" onChange={onChange} />);
    const start = screen.getByRole('radio', { name: 'کامل' });
    start.focus();

    fireEvent.keyDown(start, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('stream');

    fireEvent.keyDown(screen.getByRole('radio', { name: 'فقط پخش' }), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('none');
  });

  it('moves backward with ArrowRight under RTL, wrapping at the ends', () => {
    const onChange = vi.fn();
    render(<Harness locale="fa" onChange={onChange} />);
    const start = screen.getByRole('radio', { name: 'کامل' });
    start.focus();

    fireEvent.keyDown(start, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('none');
  });

  it('reverses the mapping under LTR', () => {
    const onChange = vi.fn();
    render(<Harness locale="en" onChange={onChange} />);
    const start = screen.getByRole('radio', { name: label('en', 'full') });
    start.focus();

    fireEvent.keyDown(start, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('stream');

    fireEvent.keyDown(screen.getByRole('radio', { name: label('en', 'stream') }), {
      key: 'ArrowLeft',
    });
    expect(onChange).toHaveBeenLastCalledWith('full');
  });

  it('moves on the vertical arrows too, which do not flip', () => {
    const onChange = vi.fn();
    render(<Harness locale="fa" onChange={onChange} />);
    const start = screen.getByRole('radio', { name: 'کامل' });
    start.focus();

    fireEvent.keyDown(start, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenCalledWith('stream');
  });

  it('jumps to the ends with Home and End', () => {
    const onChange = vi.fn();
    render(<Harness locale="fa" initial="stream" onChange={onChange} />);
    const start = screen.getByRole('radio', { name: 'فقط پخش' });
    start.focus();

    fireEvent.keyDown(start, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('none');

    fireEvent.keyDown(screen.getByRole('radio', { name: 'بسته' }), { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('full');
  });

  it('moves focus with the selection, so the arrows can be pressed again', () => {
    render(<Harness locale="fa" />);
    const start = screen.getByRole('radio', { name: 'کامل' });
    start.focus();
    fireEvent.keyDown(start, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'فقط پخش' }));
  });

  it('selects with Space without moving', () => {
    const onChange = vi.fn();
    render(<Harness locale="fa" onChange={onChange} />);
    const closed = screen.getByRole('radio', { name: 'بسته' });
    fireEvent.keyDown(closed, { key: ' ' });
    expect(onChange).toHaveBeenCalledWith('none');
  });

  it('selects on click', () => {
    const onChange = vi.fn();
    render(<Harness locale="fa" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'فقط پخش' }));
    expect(onChange).toHaveBeenCalledWith('stream');
  });

  it('ignores the keyboard when disabled', () => {
    const onChange = vi.fn();
    render(
      <LocaleProvider locale="fa">
        <AccessModeSelector value="full" onChange={onChange} disabled />
      </LocaleProvider>,
    );
    fireEvent.keyDown(screen.getByRole('radio', { name: 'کامل' }), { key: 'ArrowLeft' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
