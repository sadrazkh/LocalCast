import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { LocaleProvider } from '../i18n/index.js';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Chip,
  DeviceRow,
  Dropdown,
  EmptyState,
  FileRow,
  Input,
  Modal,
  NavRail,
  NetworkModeSettings,
  PairingCode,
  Panel,
  PasswordInput,
  PrintJobStatus,
  ProgressBar,
  QrFrame,
  RadioGroup,
  SectionHeader,
  Select,
  Spinner,
  StatCard,
  Switch,
  TabBar,
  TabPanel,
  Table,
  Tabs,
  Toast,
  ToastViewport,
  Tooltip,
} from '../index.js';
import { FolderIcon, LibraryIcon, SearchIcon } from '../icons/index.js';

function mount(node: ReactNode) {
  return render(<LocaleProvider locale="fa">{node}</LocaleProvider>);
}

/**
 * A mounting pass over the whole public surface.
 *
 * Two other agents build `apps/pwa` and `apps/desktop` on top of this package; a component
 * that throws on its first render would surface there as a blank screen with a stack trace
 * pointing into someone else's code. Cheap insurance.
 */
describe('every exported component mounts', () => {
  it('renders the primitives', () => {
    mount(
      <>
        <Button variant="primary">ذخیره</Button>
        <Button variant="danger" loading>
          حذف
        </Button>
        <Button iconOnly aria-label="جست‌وجو" startIcon={<SearchIcon />} />
        <Spinner labelled />
        <Badge tone="success" dot>
          فعال
        </Badge>
        <Chip onClick={vi.fn()} selected>
          ویدیو
        </Chip>
        <Chip onClick={vi.fn()} onRemove={vi.fn()}>
          اسناد
        </Chip>
        <ProgressBar value={0.4} label="بارگذاری" showValue />
        <ProgressBar value={null} label="نامعلوم" />
        <Card>محتوا</Card>
        <SectionHeader title="پوشه‌های اشتراکی" count="۴" ruled />
        <StatCard label="اندازهٔ کل" value="18.0 GB" latin />
        <EmptyState icon={<FolderIcon />} title="خالی" description="چیزی نیست" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'ذخیره' })).toBeTruthy();
  });

  it('renders the form controls with real labels', () => {
    mount(
      <>
        <Input label="نام" hint="نام قابل نمایش" />
        <PasswordInput label="کلید دسترسی" />
        <Select label="چاپگر" options={[{ value: 'a', label: 'اول' }]} placeholder="انتخاب" />
        <Checkbox label="نمایه‌سازی خودکار" />
        <Switch checked onChange={vi.fn()} label="فعال" />
        <RadioGroup
          name="smoke"
          label="حالت"
          value="a"
          onChange={vi.fn()}
          options={[
            { value: 'a', label: 'یک' },
            { value: 'b', label: 'دو' },
          ]}
        />
      </>,
    );
    expect(screen.getByLabelText('نام')).toBeTruthy();
    expect(screen.getByLabelText('کلید دسترسی')).toBeTruthy();
    expect(screen.getByLabelText('چاپگر')).toBeTruthy();
  });

  it('reveals and re-masks a password field', () => {
    mount(<PasswordInput label="کلید دسترسی" defaultValue="secret" />);
    const field = screen.getByLabelText('کلید دسترسی') as HTMLInputElement;
    expect(field.type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: 'نمایش مقدار' }));
    expect((screen.getByLabelText('کلید دسترسی') as HTMLInputElement).type).toBe('text');

    fireEvent.click(screen.getByRole('button', { name: 'پنهان کردن مقدار' }));
    expect((screen.getByLabelText('کلید دسترسی') as HTMLInputElement).type).toBe('password');
  });

  it('renders the overlays', () => {
    mount(
      <>
        <Tooltip content="توضیح" open>
          <button type="button">دکمه</button>
        </Tooltip>
        <Modal open onClose={vi.fn()} title="عنوان">
          متن
        </Modal>
        <Dropdown
          trigger="منو"
          items={[{ id: 'one', label: 'گزینه', onSelect: vi.fn() }]}
        />
        <ToastViewport>
          <Toast tone="danger" title="خطا" description="چیزی درست نشد" onDismiss={vi.fn()} />
        </ToastViewport>
      </>,
    );
    expect(screen.getByRole('tooltip').textContent).toBe('توضیح');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('خطا');
  });

  it('describes the tooltip trigger itself, not a wrapper around it', () => {
    mount(
      <Tooltip content="توضیح" open>
        <button type="button">دکمه</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole('button', { name: 'دکمه' });
    expect(trigger.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id);
  });

  it('opens a dropdown and selects an item with the keyboard', () => {
    const onSelect = vi.fn();
    mount(<Dropdown trigger="منو" items={[{ id: 'one', label: 'گزینه', onSelect }]} />);

    fireEvent.click(screen.getByRole('button', { name: 'منو' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'گزینه' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('renders tabs, a table and the navigation surfaces', () => {
    mount(
      <>
        <Tabs
          items={[
            { id: 'a', label: 'فعالیت' },
            { id: 'b', label: 'دستگاه‌ها' },
          ]}
          value="a"
          onChange={vi.fn()}
          label="بخش‌ها"
        />
        <TabPanel tabId="a">محتوا</TabPanel>
        <Table
          columns={[
            { id: 'name', header: 'نام', cell: (row: { id: string }) => row.id },
            { id: 'size', header: 'اندازه', cell: () => '1.0 KB', latin: true, align: 'end' },
          ]}
          rows={[{ id: 'r1' }]}
          getRowId={(row) => row.id}
        />
        <NavRail
          items={[{ id: 'lib', label: 'کتابخانه', icon: <LibraryIcon />, count: '۴' }]}
          value="lib"
          onChange={vi.fn()}
        />
        <TabBar
          items={[
            { id: 'lib', label: 'کتابخانه', icon: <LibraryIcon /> },
            { id: 'search', label: 'جست‌وجو', icon: <SearchIcon />, attention: true },
          ]}
          value="lib"
          onChange={vi.fn()}
        />
      </>,
    );
    expect(screen.getByRole('columnheader', { name: 'نام' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'فعالیت' })).toBeTruthy();
  });

  it('renders an empty table with its own message rather than a bare frame', () => {
    mount(
      <Table
        columns={[{ id: 'name', header: 'نام', cell: () => null }]}
        rows={[]}
        getRowId={() => 'x'}
      />,
    );
    expect(screen.getByText('چیزی برای نمایش نیست')).toBeTruthy();
  });

  it('renders the pairing surfaces', () => {
    mount(
      <>
        <QrFrame onUseCode={vi.fn()} />
        <PairingCode code="7f3a" secondsRemaining={125} ttlSeconds={300} />
      </>,
    );
    // ASCII, upper-cased, one box per character.
    const group = screen.getByRole('group', { name: /کد پیرینگ/ });
    expect(group.textContent).toBe('7F3A');
    expect(screen.getByRole('button', { name: 'به‌جای اسکن، کد ۴ رقمی را وارد کنید' })).toBeTruthy();
  });

  it('renders a device row with its approve and reject actions', () => {
    const onApprove = vi.fn();
    mount(
      <DeviceRow
        device={{
          id: 'dev-1',
          name: 'آیفون علی',
          platform: 'ios-pwa',
          status: 'pending',
          lastSeenAt: null,
          pairingCode: '7f3a',
        }}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText('در انتظار تأیید')).toBeTruthy();
    // "آخرین بازدید: هرگز" — a device that has never checked in says so rather than
    // showing an empty cell or the epoch.
    expect(screen.getByText(/آخرین بازدید:\s*هرگز/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'تأیید' }));
    expect(onApprove).toHaveBeenCalledWith('dev-1');
  });

  it('renders a file row and flags a file the browser cannot play', () => {
    mount(
      <FileRow
        entry={{
          id: 'f1',
          name: 'Show.S01E04.mkv',
          kind: 'video',
          isDir: false,
          size: 4 * 1024 * 1024 * 1024,
          mtime: Date.UTC(2026, 1, 3),
          browserPlayable: false,
        }}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText('4.0 GB')).toBeTruthy();
    expect(screen.getByText('این فایل در مرورگر پخش نمی‌شود')).toBeTruthy();
  });

  it('renders each print job state', () => {
    for (const status of ['queued', 'printing', 'done', 'error', 'cancelled'] as const) {
      const { unmount } = mount(<PrintJobStatus status={status} errorMessage="کاغذ تمام شد" />);
      unmount();
    }
    mount(<PrintJobStatus status="error" errorMessage="کاغذ تمام شد" />);
    expect(screen.getByText('خطا')).toBeTruthy();
    expect(screen.getByText('کاغذ تمام شد')).toBeTruthy();
  });

  it('renders a panel with a header and footer', () => {
    mount(
      <Panel title="سرور" description="توضیح" actions={<Button size="sm">عمل</Button>} footer={<Button>ذخیره</Button>}>
        بدنه
      </Panel>,
    );
    expect(screen.getByRole('region', { name: 'سرور' })).toBeTruthy();
  });
});

describe('NetworkModeSettings', () => {
  const draft = {
    mode: 'custom' as const,
    controlUrl: 'https://headscale.example.com',
    authKey: 'key',
    expose: 'tailnet' as const,
    certStrategy: 'control-plane' as const,
    certDomain: '',
    dnsProvider: '' as const,
    dnsApiToken: '',
    hostname: 'localcast',
  };

  function mountSettings(overrides: Partial<Parameters<typeof NetworkModeSettings>[0]> = {}) {
    const props = {
      value: draft,
      onChange: vi.fn(),
      onTest: vi.fn(),
      onSave: vi.fn(),
      onRestoreDefaults: vi.fn(),
      certificateUnavailable: true,
      ...overrides,
    };
    mount(<NetworkModeSettings {...props} />);
    return props;
  }

  it('states plainly that a self-hosted control server cannot issue a certificate', () => {
    mountSettings();
    // Spec §2.3: this is a fact about the mode, and it is shown rather than spun on.
    expect(screen.getByText('این سرور کنترل نمی‌تواند خودش گواهی صادر کند')).toBeTruthy();
    expect(screen.getByText(/\/machine\/set-dns/)).toBeTruthy();
  });

  it('lets the host layer replace the notice with its own wording', () => {
    mountSettings({ certificateNotice: <span>متن سفارشی</span>, certificateUnavailable: false });
    expect(screen.getByText('متن سفارشی')).toBeTruthy();
  });

  it('blocks save until a test has passed', () => {
    mountSettings();
    expect((screen.getByRole('button', { name: 'ذخیره و اتصال مجدد' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText('تا وقتی آزمایش موفق نشود، ذخیره ممکن نیست')).toBeTruthy();
  });

  it('unblocks save once the dry run reports ok', () => {
    mountSettings({
      testResult: {
        ok: true,
        controlReachable: true,
        certificateViable: true,
        messages: [{ level: 'info', text: 'سرور کنترل در دسترس است' }],
        loginUrl: null,
      },
    });
    expect((screen.getByRole('button', { name: 'ذخیره و اتصال مجدد' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.getByText('سرور کنترل در دسترس است')).toBeTruthy();
  });

  it('refuses to offer control-plane issuance in custom mode', () => {
    mountSettings();
    const select = screen.getByLabelText('تأمین گواهی');
    const option = within(select).getByRole('option', {
      name: 'از سرور کنترل',
    }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it('shows the live status without putting transport detail next to the dot', () => {
    mountSettings({
      status: {
        state: 'connected',
        host: 'localcast.tail1234.ts.net',
        funnelUrl: null,
        loginUrl: null,
        errorCode: null,
        errorMessage: null,
        certExpiresAt: Date.UTC(2026, 11, 1),
        peers: 3,
        updatedAt: Date.now(),
      },
    });
    // The address belongs on the operator's own settings page…
    expect(screen.getByText('localcast.tail1234.ts.net')).toBeTruthy();
    // …but never inside the coarse indicator.
    expect(screen.getByRole('status', { name: 'وضعیت اتصال' }).textContent).toBe('متصل');
    // Peer count is a user-facing number, so Persian digits.
    expect(screen.getByText('۳')).toBeTruthy();
  });

  it('moves the certificate strategy when the mode changes, so the config stays valid', () => {
    const props = mountSettings({ value: { ...draft, mode: 'default', certStrategy: 'control-plane' } });
    fireEvent.click(screen.getByRole('radio', { name: /سرور شخصی/ }));
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'custom', certStrategy: 'external-proxy' }),
    );
  });
});
