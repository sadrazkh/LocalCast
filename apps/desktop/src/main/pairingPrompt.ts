import type { DeviceSummary } from '@localcast/contract';

/**
 * Asking the person at the computer whether a device may connect.
 *
 * ## What was missing
 *
 * A phone would scan the code, the claim would land, the row would be written with
 * `status: 'pending'` — and then nothing. No notification, no dialog, nothing on screen anywhere
 * unless the user happened to already be looking at the devices list and happened to refresh it.
 * The phone sat on «در انتظار تأیید» for five minutes and then gave up. Reported, accurately, as
 * "nothing is even detected".
 *
 * The data was always there. There was simply no code that turned a pending device into something
 * a human would notice.
 *
 * ## Why a modal dialog and not only a toast
 *
 * A Windows toast can be missed, can be suppressed by Focus Assist, and disappears on its own.
 * The decision this asks for is the one that grants a stranger's phone access to the user's files,
 * and it is time-limited — the pairing token lives five minutes. So both: a toast, because that is
 * the thing that draws the eye and lands in the Action Center, and a modal box, because that is
 * the thing that cannot be missed and can actually collect an answer.
 *
 * ## Why every dependency is injected
 *
 * `Notification` and `dialog` come from Electron and cannot run in a unit test. Passing them in
 * means the logic here — deduplicating, resolving the device's name, choosing approve or reject,
 * coping with a device that vanished — is tested against fakes rather than being taken on trust.
 */

export interface PairingPromptStrings {
  notificationTitle: string;
  /** `%s` is replaced with the device name. */
  notificationBody: string;
  question: string;
  detail: string;
  approve: string;
  reject: string;
}

const STRINGS: Record<'fa' | 'en', PairingPromptStrings> = {
  fa: {
    notificationTitle: 'دستگاه جدید',
    notificationBody: '%s می‌خواهد به LocalCast وصل شود',
    question: 'به «%s» اجازه‌ی دسترسی می‌دهید؟',
    detail:
      'این دستگاه کد اتصال را وارد کرده است. با تأیید، به پوشه‌هایی که برایش تعیین شده دسترسی پیدا می‌کند. هر وقت بخواهید می‌توانید از بخش دستگاه‌ها دسترسی‌اش را ببندید.',
    approve: 'تأیید',
    reject: 'رد',
  },
  en: {
    notificationTitle: 'New device',
    notificationBody: '%s wants to connect to LocalCast',
    question: 'Allow “%s” to connect?',
    detail:
      'This device entered the pairing code. Approving gives it access to the folders assigned to it. You can close its access from the Devices screen at any time.',
    approve: 'Approve',
    reject: 'Reject',
  },
};

export interface PairingPromptDeps {
  /** Reads and writes devices through the operator API. */
  devices: {
    list(): Promise<DeviceSummary[]>;
    approve(id: string): Promise<unknown>;
    reject(id: string): Promise<unknown>;
  };
  /**
   * Shows a Windows toast. Clicking it should surface the panel, which is what `onOpenPanel` is
   * for — a person who dismissed the dialog needs a way back to the decision.
   */
  notify(input: { title: string; body: string; onClick: () => void }): void;
  /** Resolves true to approve, false to reject. */
  ask(input: {
    question: string;
    detail: string;
    approveLabel: string;
    rejectLabel: string;
  }): Promise<boolean>;
  onOpenPanel(route: string): void;
  locale: () => 'fa' | 'en';
  log?: { info(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void };
}

export interface PairingPrompt {
  /**
   * Feed it a server event. Anything that is not a device turning up pending is ignored, so the
   * caller can hand it the whole unfiltered stream without a switch of its own.
   */
  handle(event: { type: string; [key: string]: unknown }): void;
  /** Awaits whatever prompt is in flight. Tests use it; production does not need to. */
  settled(): Promise<void>;
}

export function createPairingPrompt(deps: PairingPromptDeps): PairingPrompt {
  /**
   * Devices already being asked about.
   *
   * Without it the same device can raise two dialogs: a claim publishes one event, but a phone
   * whose first poll times out will re-claim, and the operator would then be answering the same
   * question twice — with the second answer landing on a device the first one already revoked.
   */
  const asking = new Set<string>();
  let chain: Promise<void> = Promise.resolve();

  function nameOf(device: DeviceSummary | undefined, deviceId: string): string {
    const name = device?.name?.trim();
    return name !== undefined && name.length > 0 ? name : deviceId.slice(0, 8);
  }

  async function run(deviceId: string): Promise<void> {
    const strings = STRINGS[deps.locale()];
    let device: DeviceSummary | undefined;
    try {
      device = (await deps.devices.list()).find((d) => d.id === deviceId);
    } catch (err) {
      // The operator API is on loopback and in the same process, so this is nearly impossible —
      // but a prompt that cannot name the device is still better than no prompt at all.
      deps.log?.warn('could not read the device that is waiting to be approved', {
        deviceId,
        error: String(err),
      });
    }

    // Approved, rejected or revoked between the event and here. Nothing to ask.
    if (device !== undefined && device.status !== 'pending') return;

    const label = nameOf(device, deviceId);
    deps.log?.info('a device is waiting to be approved', { deviceId, name: label });

    deps.notify({
      title: strings.notificationTitle,
      body: strings.notificationBody.replace('%s', label),
      onClick: () => deps.onOpenPanel('/panel/devices'),
    });

    const approved = await deps.ask({
      question: strings.question.replace('%s', label),
      detail: strings.detail,
      approveLabel: strings.approve,
      rejectLabel: strings.reject,
    });

    try {
      if (approved) await deps.devices.approve(deviceId);
      else await deps.devices.reject(deviceId);
      deps.log?.info(approved ? 'device approved' : 'device rejected', { deviceId, name: label });
    } catch (err) {
      // The most likely cause is the pairing token expiring while the box was open. The panel
      // shows the real state either way, so this is reported rather than retried.
      deps.log?.warn('could not record the decision about this device', {
        deviceId,
        error: String(err),
      });
    }
  }

  return {
    handle(event) {
      if (event['type'] !== 'device' || event['status'] !== 'pending') return;
      const deviceId = event['deviceId'];
      if (typeof deviceId !== 'string' || deviceId.length === 0) return;
      if (asking.has(deviceId)) return;
      asking.add(deviceId);

      /**
       * One at a time, in order.
       *
       * Two modal boxes at once is a stack of windows on top of each other where the second is
       * unreachable until the first is answered — and on Windows the second can end up behind
       * the first with no way to tell it is there.
       */
      chain = chain
        .then(() => run(deviceId))
        .catch(() => undefined)
        .finally(() => {
          asking.delete(deviceId);
        });
    },
    settled() {
      return chain;
    },
  };
}
