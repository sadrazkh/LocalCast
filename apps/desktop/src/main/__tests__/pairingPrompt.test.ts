// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { DeviceSummary } from '@localcast/contract';
import { createPairingPrompt } from '../pairingPrompt.js';

/**
 * A device that has entered the pairing code has to become something a person can answer.
 *
 * This is the gap the user reported as "nothing is even detected". The claim landed, the row was
 * written `pending`, and then nothing happened anywhere: no toast, no dialog, nothing on screen
 * unless somebody was already looking at the devices list and refreshed it. The phone waited five
 * minutes for an approval nobody had been asked for.
 */

function device(overrides: Partial<DeviceSummary> = {}): DeviceSummary {
  return {
    id: 'dev-1',
    name: 'iPhone',
    platform: 'ios-pwa',
    status: 'pending',
    lastSeenAt: null,
    pairingCode: 'A7K2',
    permissions: [],
    ...overrides,
  };
}

interface Harness {
  toasts: { title: string; body: string }[];
  asked: { question: string; detail: string }[];
  approved: string[];
  rejected: string[];
  opened: string[];
  clickToast: () => void;
}

function harness(options: { answer?: boolean | (() => boolean); devices?: DeviceSummary[]; listFails?: boolean } = {}) {
  const state: Harness = {
    toasts: [],
    asked: [],
    approved: [],
    rejected: [],
    opened: [],
    clickToast: () => undefined,
  };
  const answer = options.answer ?? true;

  const prompt = createPairingPrompt({
    devices: {
      list: () =>
        options.listFails === true
          ? Promise.reject(new Error('loopback refused'))
          : Promise.resolve(options.devices ?? [device()]),
      approve: (id) => {
        state.approved.push(id);
        return Promise.resolve();
      },
      reject: (id) => {
        state.rejected.push(id);
        return Promise.resolve();
      },
    },
    notify: ({ title, body, onClick }) => {
      state.toasts.push({ title, body });
      state.clickToast = onClick;
    },
    ask: ({ question, detail }) => {
      state.asked.push({ question, detail });
      return Promise.resolve(typeof answer === 'function' ? answer() : answer);
    },
    onOpenPanel: (route) => state.opened.push(route),
    locale: () => 'fa',
  });

  return { prompt, state };
}

describe('asking whether a device may connect', () => {
  it('raises a toast and a dialog, and approves when the operator says yes', async () => {
    const { prompt, state } = harness({ answer: true });

    prompt.handle({ type: 'device', status: 'pending', deviceId: 'dev-1' });
    await prompt.settled();

    // The toast, because that is what draws the eye and lands in the Action Center.
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]?.body).toContain('iPhone');
    // The dialog, because a toast can be missed, suppressed by Focus Assist, or simply time out —
    // and this decision is what grants a phone access to the user's files.
    expect(state.asked).toHaveLength(1);
    expect(state.asked[0]?.question).toContain('iPhone');
    expect(state.approved).toEqual(['dev-1']);
    expect(state.rejected).toEqual([]);
  });

  it('rejects when the operator says no', async () => {
    const { prompt, state } = harness({ answer: false });

    prompt.handle({ type: 'device', status: 'pending', deviceId: 'dev-1' });
    await prompt.settled();

    expect(state.rejected).toEqual(['dev-1']);
    expect(state.approved).toEqual([]);
  });

  it('takes the operator to the devices screen when the toast is clicked', async () => {
    const { prompt, state } = harness();
    prompt.handle({ type: 'device', status: 'pending', deviceId: 'dev-1' });
    await prompt.settled();

    state.clickToast();
    expect(state.opened).toEqual(['/panel/devices']);
  });

  it('asks once per device, however many times the event arrives', async () => {
    // A phone whose first status poll times out re-claims, which publishes the event again. Two
    // dialogs would mean the operator answering the same question twice, with the second answer
    // landing on a device the first one may already have revoked.
    const { prompt, state } = harness();

    prompt.handle({ type: 'device', status: 'pending', deviceId: 'dev-1' });
    prompt.handle({ type: 'device', status: 'pending', deviceId: 'dev-1' });
    prompt.handle({ type: 'device', status: 'pending', deviceId: 'dev-1' });
    await prompt.settled();

    expect(state.asked).toHaveLength(1);
    expect(state.approved).toEqual(['dev-1']);
  });

  it('asks about two different devices one after the other', async () => {
    // Serialised on purpose: two modal boxes at once is a stack where the second is unreachable,
    // and on Windows it can end up behind the first with no sign that it is there.
    const { prompt, state } = harness({
      devices: [device({ id: 'dev-1', name: 'iPhone' }), device({ id: 'dev-2', name: 'Pixel' })],
    });

    prompt.handle({ type: 'device', status: 'pending', deviceId: 'dev-1' });
    prompt.handle({ type: 'device', status: 'pending', deviceId: 'dev-2' });
    await prompt.settled();

    expect(state.asked).toHaveLength(2);
    expect(state.approved).toEqual(['dev-1', 'dev-2']);
  });

  it('says nothing about a device that is no longer waiting', async () => {
    // Approved from the panel, or rejected, between the event and this running. Asking about it
    // would be asking the operator to decide something they have already decided.
    const { prompt, state } = harness({ devices: [device({ status: 'active' })] });

    prompt.handle({ type: 'device', status: 'pending', deviceId: 'dev-1' });
    await prompt.settled();

    expect(state.asked).toEqual([]);
    expect(state.toasts).toEqual([]);
    expect(state.approved).toEqual([]);
  });

  it('still asks when the device list cannot be read', async () => {
    // A prompt that cannot name the device is worth far more than no prompt: the pairing token
    // lives five minutes, and silence is what this whole module exists to replace.
    const { prompt, state } = harness({ listFails: true, answer: true });

    prompt.handle({ type: 'device', status: 'pending', deviceId: 'dev-abcdef123' });
    await prompt.settled();

    expect(state.asked).toHaveLength(1);
    expect(state.asked[0]?.question).toContain('dev-abcd');
    expect(state.approved).toEqual(['dev-abcdef123']);
  });

  it.each([
    ['a device that became active', { type: 'device', status: 'active', deviceId: 'dev-1' }],
    ['a revocation', { type: 'device', status: 'revoked', deviceId: 'dev-1' }],
    ['a heartbeat', { type: 'heartbeat', at: 1 }],
    ['a print job', { type: 'print', jobId: 'j1', status: 'printing' }],
    ['an event with no device id', { type: 'device', status: 'pending' }],
  ])('ignores %s', async (_why, event) => {
    // The whole unfiltered stream is handed to this, so everything it is not interested in has to
    // pass through silently rather than the caller needing a switch of its own.
    const { prompt, state } = harness();
    prompt.handle(event as { type: string });
    await prompt.settled();
    expect(state.asked).toEqual([]);
    expect(state.toasts).toEqual([]);
  });
});
