import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Printer } from '@localcast/contract';
import { LocaleProvider } from '../i18n/index.js';
import { PrintDialog } from './PrintDialog.js';

const printers: Printer[] = [
  {
    id: 'prn-office',
    name: 'HP LaserJet M404',
    isDefault: true,
    colorCapable: false,
    duplexCapable: true,
    status: 'Idle',
    online: true,
  },
  {
    id: 'prn-colour',
    name: 'Canon G3020',
    isDefault: false,
    colorCapable: true,
    duplexCapable: false,
    status: 'Idle',
    online: true,
  },
  {
    id: 'prn-dead',
    name: 'Brother HL-1210W',
    isDefault: false,
    colorCapable: false,
    duplexCapable: false,
    status: 'Offline',
    online: false,
  },
];

const source = { kind: 'library', fileId: 'file-42' } as const;

function renderDialog(onSubmit = vi.fn()) {
  render(
    <LocaleProvider locale="fa">
      <PrintDialog
        open
        onClose={vi.fn()}
        printers={printers}
        source={source}
        fileName="قرارداد.pdf"
        onSubmit={onSubmit}
      />
    </LocaleProvider>,
  );
  return onSubmit;
}

const submitButton = () => screen.getByRole('button', { name: 'ارسال به چاپ' });
const printerSelect = () => screen.getByLabelText('چاپگر') as HTMLSelectElement;

describe('PrintDialog', () => {
  it('opens with no printer chosen and submit disabled', () => {
    renderDialog();
    expect(printerSelect().value).toBe('');
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not pre-select the Windows default printer', () => {
    renderDialog();
    // `Get-Printer` frequently reports a PDF writer as the default; auto-selecting it means
    // a tap-through prints to the wrong place.
    expect(printerSelect().value).not.toBe('prn-office');
  });

  it('enables submit once a printer is chosen', () => {
    renderDialog();
    fireEvent.change(printerSelect(), { target: { value: 'prn-office' } });
    expect((submitButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('marks an offline printer as unselectable', () => {
    renderDialog();
    const option = screen.getByRole('option', {
      name: /Brother HL-1210W/,
    }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it('emits exactly the PrintRequest shape from the contract', () => {
    const onSubmit = renderDialog();
    fireEvent.change(printerSelect(), { target: { value: 'prn-office' } });
    fireEvent.click(submitButton());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      printerId: 'prn-office',
      source: { kind: 'library', fileId: 'file-42' },
      copies: 1,
      color: 'mono',
      duplex: 'simplex',
    });

    // `pageRange` is optional in the schema and absent means "every page"; sending an empty
    // string instead would be a different request.
    const request = onSubmit.mock.calls[0]?.[0];
    expect(request).not.toHaveProperty('pageRange');
  });

  it('carries the edited copies, colour, duplex and page range through', () => {
    const onSubmit = renderDialog();
    fireEvent.change(printerSelect(), { target: { value: 'prn-colour' } });
    fireEvent.change(screen.getByLabelText('تعداد نسخه'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('radio', { name: 'رنگی' }));
    fireEvent.change(screen.getByLabelText('محدودهٔ صفحات'), { target: { value: '1-4,7' } });
    fireEvent.click(submitButton());

    expect(onSubmit).toHaveBeenCalledWith({
      printerId: 'prn-colour',
      source: { kind: 'library', fileId: 'file-42' },
      copies: 3,
      color: 'color',
      duplex: 'simplex',
      pageRange: '1-4,7',
    });
  });

  it('normalises a copies count typed on a Persian keyboard', () => {
    const onSubmit = renderDialog();
    fireEvent.change(printerSelect(), { target: { value: 'prn-office' } });
    fireEvent.change(screen.getByLabelText('تعداد نسخه'), { target: { value: '۵' } });
    fireEvent.click(submitButton());

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ copies: 5 }));
  });

  it('blocks submission on a copies count outside 1–99', () => {
    const onSubmit = renderDialog();
    fireEvent.change(printerSelect(), { target: { value: 'prn-office' } });
    fireEvent.change(screen.getByLabelText('تعداد نسخه'), { target: { value: '250' } });

    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submitButton());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disables colour on a mono-only printer', () => {
    renderDialog();
    fireEvent.change(printerSelect(), { target: { value: 'prn-office' } });
    expect((screen.getByRole('radio', { name: 'رنگی' }) as HTMLInputElement).disabled).toBe(true);
  });
});
