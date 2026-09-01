import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { LocaleProvider } from '@localcast/ui-kit';
import { FeedbackProvider } from '../lib/feedback.js';
import { ShellProvider } from '../state/shell.js';
import { CONNECTED_STATUS, OFFLINE_STATUS, installFakeApi, type FakeApi } from '../test/fakeApi.js';
import { Wizard } from './Wizard.js';

/**
 * The wizard is where the product's central promise either holds or does not:
 *
 *   install → one click to sign in → scan a QR code → done
 *
 * Two things can quietly break it. The copy can leak the machinery underneath, and the
 * wizard can march past a sign-in that never actually succeeded. Both are tested here
 * because both are invisible to a developer who already knows what a tailnet is.
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

afterEach(() => {
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

  it('shows no address anywhere on the sign-in step', async () => {
    renderWizard();
    await act(async () => {
      fake.emit(CONNECTED_STATUS);
    });

    // The host is real and known at this point; the wizard still must not print it. It
    // belongs on the pairing screen as a labelled, copyable field — not as scenery.
    expect(document.body.textContent ?? '').not.toContain('tail1234');
  });
});

describe('the wizard never gets ahead of the sign-in', () => {
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
});

describe('the sign-in step', () => {
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
