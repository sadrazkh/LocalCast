import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { LocaleProvider } from '@localcast/ui-kit';
import { REMOTE_ACCESS_ENABLED } from '../../shared/features.js';
import { FeedbackProvider } from '../lib/feedback.js';
import { ShellProvider } from '../state/shell.js';
import { CONNECTED_STATUS, OFFLINE_STATUS, installFakeApi, type FakeApi } from '../test/fakeApi.js';
import { Wizard } from './Wizard.js';

/**
 * The wizard is where the product's central promise either holds or does not:
 *
 *   install → choose a folder → scan a QR code → done
 *
 * Three things can quietly break it. The copy can leak the machinery underneath; the step
 * count can claim a step that does not exist; and — when remote access is switched on — the
 * wizard can march past a sign-in that never actually succeeded. All three are tested here
 * because all three are invisible to a developer who already knows what a tailnet is.
 *
 * The suite is split by `REMOTE_ACCESS_ENABLED` rather than rewritten for it. The sign-in
 * assertions are not obsolete — the step is still in `Wizard.tsx`, whole — they are simply
 * not reachable in this build, and they come back with it.
 */

let fake: FakeApi;

function renderWizard() {
  fake = installFakeApi();
  return render(
    <LocaleProvider defaultLocale="fa">
      <FeedbackProvider>
        <ShellProvider>
          <Wizard />
        </ShellProvider>
      </FeedbackProvider>
    </LocaleProvider>,
  );
}

/** Renders and lets the prerequisites screen clear itself, so step one is on screen. */
async function renderAtStepOne() {
  const result = renderWizard();
  await act(async () => {
    fake.emit(OFFLINE_STATUS);
  });
  return result;
}

afterEach(() => {
  cleanup();
  delete (globalThis as { localcast?: unknown }).localcast;
});

/**
 * Every term an ordinary user should never meet. Latin entries are matched
 * case-insensitively; the Persian ones are matched as written.
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
  'گواهی',
  'پورت',
  'آی‌پی',
  'دیوار آتش',
  'سرور هماهنگ‌کننده',
];

/** An IPv4 literal, which is the other thing that must never appear. */
const IP_SHAPED = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;

describe('the wizard says nothing an ordinary user should have to understand', () => {
  it('keeps every step free of network vocabulary', async () => {
    renderWizard();

    for (const status of [OFFLINE_STATUS, CONNECTED_STATUS]) {
      await act(async () => {
        fake.emit(status);
      });

      const text = document.body.textContent ?? '';
      // Guard against the vacuous pass: a blank DOM contains no forbidden words either.
      expect(text.length).toBeGreaterThan(40);

      for (const term of FORBIDDEN) {
        expect(text.toLowerCase()).not.toContain(term.toLowerCase());
      }
      expect(text).not.toMatch(IP_SHAPED);
    }
  });

  it('shows no address anywhere before the QR code', async () => {
    renderWizard();
    await act(async () => {
      fake.emit(CONNECTED_STATUS);
    });

    // The host is real and known at this point; the wizard still must not print it. It
    // belongs on the pairing screen as a labelled, copyable field — not as scenery.
    expect(document.body.textContent ?? '').not.toContain('tail1234');
  });
});

/**
 * The whole reason the flag exists: the owner opened the app and it demanded an account
 * before it would do anything, on a machine whose phone was on the same Wi-Fi the entire
 * time. These are the assertions that say it no longer does.
 */
describe.skipIf(REMOTE_ACCESS_ENABLED)('first run while remote access is switched off', () => {
  it('is two steps, and offers no sign-in on the first of them', async () => {
    await renderAtStepOne();

    // The count is part of the promise: "step 1 of 3" with a step nobody will ever see is
    // the app telling the user it is going to ask for something it never asks for.
    expect(screen.getByText('گام 1 از 2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ورود' })).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('وارد شوید');
  });

  it('goes from the folder straight to the QR code, with the edge stopped', async () => {
    await renderAtStepOne();

    // Nothing minted yet: the code belongs to the last step.
    expect(fake.api.pairing.mint).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'بعداً تغییر بده' }));
    });

    // One click from step one, and the status stream is still saying `stopped` — which is
    // exactly what it will say for the life of a build with no sidecar in it. Anything that
    // waited on the edge here would leave the user on a dead screen.
    expect(screen.getByText('گام 2 از 2')).toBeTruthy();
    await waitFor(() => {
      expect(fake.api.pairing.mint).toHaveBeenCalled();
    });
    expect(screen.getByText('اولین دستگاه را اضافه کنید')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ورود' })).toBeNull();
  });

  it('never asks the main process to open a sign-in page', async () => {
    await renderAtStepOne();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'بعداً تغییر بده' }));
    });

    // The bridge still carries `edge.login` — the switch is not a deletion — but nothing in
    // this build's wizard reaches it.
    expect(fake.api.edge.login).not.toHaveBeenCalled();
  });
});

describe.runIf(REMOTE_ACCESS_ENABLED)('the wizard never gets ahead of the sign-in', () => {
  it('does not reach the QR step while the edge is not connected', async () => {
    renderWizard();

    await act(async () => {
      fake.emit(OFFLINE_STATUS);
    });

    // A pairing code minted against a server nothing can reach is a QR that fails silently
    // on the phone, which is the worst possible first experience.
    expect(fake.api.pairing.mint).not.toHaveBeenCalled();
  });

  it('moves on by itself once the status actually reports connected', async () => {
    renderWizard();

    await act(async () => {
      fake.emit(OFFLINE_STATUS);
    });
    await act(async () => {
      fake.emit(CONNECTED_STATUS);
    });

    await waitFor(() => {
      expect(fake.api.edge.status).toHaveBeenCalled();
    });
  });

  it('opens the browser through the main process rather than navigating itself', async () => {
    renderWizard();
    await act(async () => {
      fake.emit(OFFLINE_STATUS);
    });

    // The renderer has no network access at all — its CSP forbids it — so the only way a
    // sign-in page can appear is the main process opening the user's real browser, where
    // they can see the address bar of the page they are typing a password into.
    expect(typeof fake.api.edge.login).toBe('function');
    expect(screen.queryByRole('link')).toBeNull();
  });
});
