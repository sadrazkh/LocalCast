import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@localcast/ui-kit';
import type {
  InstallOutcome,
  PreflightReport,
  PrerequisiteId,
  PrerequisiteStatus,
} from '../../../shared/preflight.js';
import { ALL_SATISFIED, installFakeApi } from '../../test/fakeApi.js';
import type { FakeApiOverrides } from '../../test/fakeApi.js';
import { PreflightStep } from '../PreflightStep.js';

/**
 * Four things about this screen are worth a test, and they are the four that would be
 * invisible to the person who wrote it:
 *
 *  - a blocking prerequisite must not offer a way past itself, and a degrading one must;
 *  - an unverifiable download must show the digest and the publisher's page, and must not
 *    install until the user says so;
 *  - the screen must vanish completely when there is nothing to say;
 *  - and none of it may leak the vocabulary the wizard spent three steps avoiding.
 */

/** Obviously synthetic: a digest that looks measured but was invented is the worse bug. */
const FAKE_DIGEST = 'deadbeef'.repeat(8);
const PUBLISHER = 'https://www.sumatrapdfreader.org/download-free-pdf-viewer';

function status(
  id: PrerequisiteId,
  patch: Partial<PrerequisiteStatus> = {},
): PrerequisiteStatus {
  return {
    id,
    severity: 'blocking',
    state: 'missing',
    searchedPaths: [],
    detail: '',
    remedies: [],
    ...patch,
  };
}

/**
 * `detail` is quoted from the main process's own detectors, English and diagnostic. That is
 * deliberate on both sides — it is text a user pastes into a bug report — and it is exactly
 * the text that must never surface as the sentence this screen leads with.
 */
const PRINT_MISSING = status('print-helper', {
  severity: 'degrading',
  detail:
    'The print helper (SumatraPDF) is not installed, so printing from a phone will fail. ' +
    'Everything else — browsing, playing video, WebDAV and uploads — works without it.',
  searchedPaths: ['C:\\Program Files\\LocalCast\\vendor\\bin\\SumatraPDF.exe'],
  remedies: [{ kind: 'download', labelKey: 'preflight.remedy.download', sourceUrl: PUBLISHER }],
});

const EDGE_MISSING = status('netedge', {
  severity: 'blocking',
  detail:
    'The network sidecar (netedge.exe) has not been built. Go 1.23.4 is installed, so ' +
    'LocalCast can build it here.',
  searchedPaths: ['C:\\Program Files\\LocalCast\\resources\\netedge.exe'],
  remedies: [
    { kind: 'command', labelKey: 'preflight.remedy.build', command: 'npm run netedge:build' },
  ],
});

function reportOf(items: PrerequisiteStatus[]): PreflightReport {
  const blocked = items.some((item) => item.severity === 'blocking' && item.state !== 'ok');
  return {
    items,
    canProceed: !blocked,
    allSatisfied: items.every((item) => item.state === 'ok'),
    checkedAt: 1,
  };
}

async function renderStep(overrides: FakeApiOverrides) {
  const fake = installFakeApi(overrides);
  const onDone = vi.fn();
  render(
    <LocaleProvider defaultLocale="fa">
      <PreflightStep onDone={onDone} />
    </LocaleProvider>,
  );
  // The first report arrives as a resolved promise; without this flush the screen is still
  // rendering nothing and every assertion below would pass vacuously.
  await act(async () => {});
  return { fake, onDone };
}

async function click(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

afterEach(() => {
  // `globals` is off in this project's vitest config, so testing-library's own auto-cleanup
  // never registers. Two of the assertions here read `document.body` directly, and would be
  // reading the previous test's screen without this.
  cleanup();
  delete (globalThis as { localcast?: unknown }).localcast;
});

describe('blocking and degrading are not the same offer', () => {
  it('gives a blocking prerequisite no way past it', async () => {
    const { onDone } = await renderStep({
      preflight: { run: vi.fn(async () => reportOf([EDGE_MISSING])) },
    });

    expect(screen.getByText('بخشی از برنامه هنوز آماده نیست')).toBeTruthy();
    // Absent, not disabled: there is nothing here to explain away.
    expect(screen.queryByRole('button', { name: 'ادامه بدون این' })).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('lets a degrading one be lived without, and says which feature that costs', async () => {
    const { onDone } = await renderStep({
      preflight: { run: vi.fn(async () => reportOf([PRINT_MISSING])) },
    });

    expect(screen.getByText(/چاپ کردن از روی گوشی/)).toBeTruthy();
    await click('ادامه بدون این');
    expect(onDone).toHaveBeenCalled();
  });
});

describe('a download the app cannot vouch for', () => {
  const unrecorded: InstallOutcome = {
    ok: false,
    id: 'print-helper',
    reason: 'digest-unrecorded',
    computedSha256: FAKE_DIGEST,
    message: 'no recorded digest for SumatraPDF.exe',
  };

  it('shows the digest and the publisher, and installs only when the user confirms', async () => {
    const install = vi.fn(async () => unrecorded);
    const { fake } = await renderStep({
      preflight: { run: vi.fn(async () => reportOf([PRINT_MISSING])), install },
    });

    await click('گرفتن و نصب');
    expect(install).toHaveBeenCalledTimes(1);

    // Not a generic failure: the computed digest and the page to check it against.
    expect(screen.getByText(FAKE_DIGEST)).toBeTruthy();
    expect(screen.getAllByText(PUBLISHER).length).toBeGreaterThan(0);
    expect(screen.getByText('این فایل را خودمان نمی‌توانیم تأیید کنیم')).toBeTruthy();

    // Looking at the publisher's page is not consent to install.
    await click('صفحهٔ نشانه‌های سازنده');
    expect(fake.api.app.openExternal).toHaveBeenCalledWith(PUBLISHER);
    expect(install).toHaveBeenCalledTimes(1);

    // The confirm control, and nothing else, starts the install of an unverified file.
    await click('مقایسه کردم؛ همین را نصب کن');
    expect(install).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenLastCalledWith('print-helper', { confirmedSha256: FAKE_DIGEST });
  });

  it('never offers to confirm a digest that does not match', async () => {
    const install = vi.fn(
      async (): Promise<InstallOutcome> => ({
        ok: false,
        id: 'print-helper',
        reason: 'digest-mismatch',
        computedSha256: FAKE_DIGEST,
        message: 'expected a different digest',
      }),
    );
    await renderStep({
      preflight: { run: vi.fn(async () => reportOf([PRINT_MISSING])), install },
    });

    await click('گرفتن و نصب');
    expect(screen.getByText('این فایل همانی نیست که باید باشد')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'مقایسه کردم؛ همین را نصب کن' })).toBeNull();
    expect(install).toHaveBeenCalledTimes(1);
  });
});

describe('the screen that is usually not there', () => {
  it('draws nothing and steps aside when everything is satisfied', async () => {
    const { onDone } = await renderStep({ preflight: { run: vi.fn(async () => ALL_SATISFIED) } });

    expect(onDone).toHaveBeenCalled();
    expect(document.body.textContent).toBe('');
  });

  it('steps aside when the main process has no prerequisites bridge at all', async () => {
    // The renderer codes against the contract and survives its absence: a screen that threw
    // here would block first run on any build where main is a commit behind.
    const fake = installFakeApi();
    delete (fake.api as unknown as { preflight?: unknown }).preflight;
    const onDone = vi.fn();
    render(
      <LocaleProvider defaultLocale="fa">
        <PreflightStep onDone={onDone} />
      </LocaleProvider>,
    );
    await act(async () => {});

    expect(onDone).toHaveBeenCalled();
    expect(document.body.textContent).toBe('');
  });
});

/**
 * The same scan the wizard is held to, for the same reason: this screen is now the very
 * first thing a user sees, so it is the easiest place for the machinery to leak out.
 */
const FORBIDDEN = [
  'tailscale',
  'tailnet',
  'headscale',
  'wireguard',
  'magicdns',
  'derp',
  'funnel',
  'certificate',
  'proxy',
  'firewall',
  'port forward',
  'sidecar',
  'گواهی',
  'پورت',
  'آی‌پی',
  'دیوار آتش',
  'سرور هماهنگ‌کننده',
];

const IP_SHAPED = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;

/**
 * The copy, as opposed to the data.
 *
 * Paths, commands, digests, publisher URLs and the main process's English diagnostics are all
 * *allowed* on this screen — that is the point of it — but only folded away behind a
 * disclosure or set as verbatim technical values. So the scan below drops the inside of every
 * `<details>`, every `<code>` and every URL, and holds what is left to the wizard's standard.
 * Dropping them is not a loophole: if the machinery ever leaks into a headline, a badge or a
 * button, none of these exclusions hide it.
 */
function visibleCopy(): string {
  const clone = document.body.cloneNode(true) as HTMLElement;
  for (const disclosure of Array.from(clone.querySelectorAll('details'))) {
    for (const child of Array.from(disclosure.children)) {
      if (child.tagName.toLowerCase() !== 'summary') child.remove();
    }
  }
  for (const code of Array.from(clone.querySelectorAll('code'))) code.remove();
  return (clone.textContent ?? '').replace(/https?:\/\/\S+/g, ' ');
}

describe('the prerequisites screen says nothing an ordinary user must decode', () => {
  it('keeps every state free of network vocabulary', async () => {
    await renderStep({
      preflight: {
        run: vi.fn(async () => reportOf([EDGE_MISSING, PRINT_MISSING])),
        install: vi.fn(async () => ({
          ok: false as const,
          id: 'print-helper' as const,
          reason: 'digest-unrecorded' as const,
          computedSha256: FAKE_DIGEST,
          message: 'no recorded digest',
        })),
      },
    });

    // Reach the command preview and the digest panel, so the scan covers everything a user
    // can get to by pressing things — not only the first paint.
    await click('همین‌جا آماده‌اش کن');
    await click('گرفتن و نصب');

    const text = visibleCopy();
    // Guard against the vacuous pass: a blank DOM contains no forbidden words either.
    expect(text.length).toBeGreaterThan(120);
    // …and against the opposite one: the diagnostic text is on the page, just not in the copy.
    expect(document.body.textContent).toContain('netedge.exe');
    for (const term of FORBIDDEN) {
      expect(text.toLowerCase()).not.toContain(term.toLowerCase());
    }
    expect(text).not.toMatch(IP_SHAPED);

    // Nor do the file names leak: what the user reads is a feature they recognise, not the
    // executable that implements it.
    expect(text).not.toContain('netedge');
    expect(text).not.toContain('SumatraPDF');
  });
});
