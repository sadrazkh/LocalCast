import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LocaleProvider } from '../i18n/index.js';
import { ConnectionDot, edgeStateToConnection } from './ConnectionDot.js';

/**
 * Anything that looks like an address, a port, a relay or a protocol name. The spec forbids
 * transport detail next to the indicator, so this is asserted against the rendered text
 * rather than trusted to review.
 */
const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
const PORT = /:\d{2,5}\b/;
const TRANSPORT_WORDS = /(derp|relay|wireguard|tailscale|headscale|tcp|udp|ts\.net|https?:)/i;

describe('ConnectionDot', () => {
  it('renders «متصل» for the connected state', () => {
    render(
      <LocaleProvider locale="fa">
        <ConnectionDot state="connected" />
      </LocaleProvider>,
    );
    expect(screen.getByRole('status').textContent).toBe('متصل');
  });

  it('renders «قطع» for the disconnected state', () => {
    render(
      <LocaleProvider locale="fa">
        <ConnectionDot state="disconnected" />
      </LocaleProvider>,
    );
    expect(screen.getByRole('status').textContent).toBe('قطع');
  });

  it('renders «در حال تلاش» for the connecting state', () => {
    render(
      <LocaleProvider locale="fa">
        <ConnectionDot state="connecting" />
      </LocaleProvider>,
    );
    expect(screen.getByRole('status').textContent).toBe('در حال تلاش');
  });

  it('translates rather than transliterates under en', () => {
    render(
      <LocaleProvider locale="en">
        <ConnectionDot state="connected" />
      </LocaleProvider>,
    );
    expect(screen.getByRole('status').textContent).toBe('Connected');
  });

  it('still names the state for assistive tech when the label is hidden', () => {
    render(
      <LocaleProvider locale="fa">
        <ConnectionDot state="connecting" showLabel={false} />
      </LocaleProvider>,
    );
    // Visually hidden, but present in the accessibility tree: colour alone is not a status.
    expect(screen.getByRole('status').textContent).toBe('در حال تلاش');
  });

  it('leaks no transport detail in any state or locale', () => {
    for (const locale of ['fa', 'en'] as const) {
      for (const state of ['connected', 'disconnected', 'connecting'] as const) {
        const { container, unmount } = render(
          <LocaleProvider locale={locale}>
            <ConnectionDot state={state} />
          </LocaleProvider>,
        );
        const text = container.textContent ?? '';
        expect(text).not.toMatch(IPV4);
        expect(text).not.toMatch(PORT);
        expect(text).not.toMatch(TRANSPORT_WORDS);

        // Nothing is smuggled through an attribute either — a title or a data-* holding the
        // host would show up on hover and in the DOM inspector.
        expect(container.innerHTML).not.toMatch(IPV4);
        expect(container.innerHTML).not.toMatch(TRANSPORT_WORDS);
        unmount();
      }
    }
  });
});

describe('edgeStateToConnection', () => {
  it('collapses the contract states to the three the dot can show', () => {
    expect(edgeStateToConnection('connected')).toBe('connected');
    expect(edgeStateToConnection('stopped')).toBe('disconnected');
    expect(edgeStateToConnection('error')).toBe('disconnected');
    expect(edgeStateToConnection('starting')).toBe('connecting');
    expect(edgeStateToConnection('connecting')).toBe('connecting');
    expect(edgeStateToConnection('login-required')).toBe('connecting');
    expect(edgeStateToConnection('obtaining-certificate')).toBe('connecting');
  });
});
