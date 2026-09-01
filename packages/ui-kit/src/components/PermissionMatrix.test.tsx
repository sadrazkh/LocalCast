import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { LocaleProvider } from '../i18n/index.js';
import { PermissionMatrix } from './PermissionMatrix.js';
import type { PermissionMatrixDevice, PermissionMatrixFolder } from './PermissionMatrix.js';

const devices: PermissionMatrixDevice[] = [
  {
    id: 'dev-iphone',
    name: 'آیفون علی',
    status: 'active',
    permissions: [{ folderId: 'fld-films', mode: 'full' }],
  },
  {
    id: 'dev-laptop',
    name: 'لپ‌تاپ کار',
    status: 'active',
    // No entry for fld-docs at all: an absent grant must read as «بسته», never as «کامل».
    permissions: [{ folderId: 'fld-films', mode: 'stream' }],
  },
  {
    id: 'dev-pending',
    name: 'گوشی مهمان',
    status: 'pending',
    permissions: [],
  },
];

const folders: PermissionMatrixFolder[] = [
  { id: 'fld-films', label: 'فیلم‌ها' },
  { id: 'fld-docs', label: 'اسناد' },
];

function renderMatrix(onChange = vi.fn()) {
  render(
    <LocaleProvider locale="fa">
      <PermissionMatrix devices={devices} folders={folders} onChange={onChange} />
    </LocaleProvider>,
  );
  return onChange;
}

const cell = (device: string, folder: string) =>
  screen.getByRole('radiogroup', { name: `دسترسی ${device} به ${folder}` });

describe('PermissionMatrix', () => {
  it('renders one cell per device × folder pair', () => {
    renderMatrix();
    expect(screen.getAllByRole('radiogroup')).toHaveLength(devices.length * folders.length);
  });

  it('labels both axes with real table headers', () => {
    renderMatrix();
    expect(screen.getByRole('columnheader', { name: 'فیلم‌ها' })).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: 'آیفون علی' })).toBeTruthy();
  });

  it('shows the stored mode for a granted folder', () => {
    renderMatrix();
    const group = cell('آیفون علی', 'فیلم‌ها');
    expect(within(group).getByRole('radio', { name: 'کامل' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('treats a missing grant as «بسته»', () => {
    renderMatrix();
    const group = cell('لپ‌تاپ کار', 'اسناد');
    expect(within(group).getByRole('radio', { name: 'بسته' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('fires onChange with (deviceId, folderId, mode) for the cell that was clicked', () => {
    const onChange = renderMatrix();
    const group = cell('لپ‌تاپ کار', 'فیلم‌ها');

    fireEvent.click(within(group).getByRole('radio', { name: 'بسته' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('dev-laptop', 'fld-films', 'none');
  });

  it('reports the second folder of the second device, not the first of the first', () => {
    const onChange = renderMatrix();
    const group = cell('لپ‌تاپ کار', 'اسناد');

    fireEvent.click(within(group).getByRole('radio', { name: 'فقط پخش' }));

    expect(onChange).toHaveBeenCalledWith('dev-laptop', 'fld-docs', 'stream');
  });

  it('carries the keyboard change through with the same coordinates', () => {
    const onChange = renderMatrix();
    const group = cell('آیفون علی', 'اسناد');
    const selected = within(group).getByRole('radio', { name: 'بسته' });
    selected.focus();

    // RTL: ArrowLeft is "next", and «بسته» is last, so it wraps round to «کامل».
    fireEvent.keyDown(selected, { key: 'ArrowLeft' });

    expect(onChange).toHaveBeenCalledWith('dev-iphone', 'fld-docs', 'full');
  });

  it('locks the row of a device that is still waiting for approval', () => {
    renderMatrix();
    const group = cell('گوشی مهمان', 'فیلم‌ها');
    for (const radio of within(group).getAllByRole('radio')) {
      expect((radio as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('shows the empty state rather than an empty grid', () => {
    render(
      <LocaleProvider locale="fa">
        <PermissionMatrix devices={[]} folders={folders} onChange={vi.fn()} />
      </LocaleProvider>,
    );
    expect(screen.getByText('هنوز دستگاهی جفت نشده است')).toBeTruthy();
  });
});
