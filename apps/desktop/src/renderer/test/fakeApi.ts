import { vi } from 'vitest';
import type { EdgeStatus, EdgeTestResult } from '@localcast/contract';
import type { DesktopApi } from '../../shared/ipc.js';

/**
 * A stand-in for `window.localcast`.
 *
 * The renderer has no other backend — every operator action goes through the preload bridge —
 * so a fake of this shape is the whole seam a renderer test needs.
 */

export const OFFLINE_STATUS: EdgeStatus = {
  state: 'stopped',
  host: null,
  funnelUrl: null,
  loginUrl: null,
  errorCode: null,
  errorMessage: null,
  certExpiresAt: null,
  peers: 0,
  updatedAt: 0,
};

export const CONNECTED_STATUS: EdgeStatus = {
  ...OFFLINE_STATUS,
  state: 'connected',
  host: 'localcast.tail1234.ts.net',
  peers: 2,
  updatedAt: 1,
};

export const VIABLE_TEST: EdgeTestResult = {
  ok: true,
  controlReachable: true,
  certificateViable: true,
  messages: [],
  loginUrl: null,
};

export interface FakeApi {
  api: DesktopApi;
  /** Pushes a status frame to every subscriber, as the main process would. */
  emit(status: EdgeStatus): void;
  listeners: ((status: EdgeStatus) => void)[];
}

export function createFakeApi(overrides: Partial<DesktopApi> = {}): FakeApi {
  const listeners: ((status: EdgeStatus) => void)[] = [];
  let status: EdgeStatus = OFFLINE_STATUS;

  const api = {
    edge: {
      status: vi.fn(async () => status),
      onEvent: (handler: (s: EdgeStatus) => void) => {
        listeners.push(handler);
        return () => {
          const i = listeners.indexOf(handler);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      test: vi.fn(async () => VIABLE_TEST),
      getConfig: vi.fn(async () => ({
        mode: 'default' as const,
        expose: 'tailnet' as const,
        certStrategy: 'control-plane' as const,
        hostname: 'localcast',
        hasAuthKey: false,
        hasDnsApiToken: false,
      })),
      applyConfig: vi.fn(async () => status),
      resetConfig: vi.fn(async () => status),
      login: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      ...overrides.edge,
    },
    folders: {
      list: vi.fn(async () => []),
      pick: vi.fn(async () => 'D:\\Movies'),
      add: vi.fn(async () => ({
        id: 'folder-1',
        label: 'Movies',
        kind: 'video' as const,
        mode: 'full' as const,
        writable: false,
        available: true,
        fileCount: 142,
        totalBytes: 902_000_000_000,
        lastIndexedAt: 1,
      })),
      update: vi.fn(),
      remove: vi.fn(),
      reindex: vi.fn(),
      ...overrides.folders,
    },
    devices: {
      list: vi.fn(async () => []),
      approve: vi.fn(),
      reject: vi.fn(),
      revoke: vi.fn(),
      rename: vi.fn(),
      setPermissions: vi.fn(),
      ...overrides.devices,
    },
    pairing: {
      mint: vi.fn(async () => ({
        code: '7F2A',
        payload: JSON.stringify({
          v: 1,
          host: 'localcast.tail1234.ts.net',
          code: '7F2A',
          secret: 'x'.repeat(43),
        }),
        expiresAt: 300_000,
      })),
      qrDataUrl: vi.fn(async () => 'data:image/png;base64,AAAA'),
      ...overrides.pairing,
    },
    printers: {
      list: vi.fn(async () => []),
      refresh: vi.fn(async () => []),
      setEnabled: vi.fn(),
      ...overrides.printers,
    },
    app: {
      info: vi.fn(async () => ({
        version: '0.1.0',
        host: null,
        serverPort: 51234,
        locale: 'fa' as const,
        setupComplete: false,
      })),
      activity: vi.fn(async () => []),
      completeWizard: vi.fn(),
      openExternal: vi.fn(),
      ...overrides.app,
    },
  } as unknown as DesktopApi;

  return {
    api,
    listeners,
    emit(next: EdgeStatus) {
      status = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
}

export function installFakeApi(overrides: Partial<DesktopApi> = {}): FakeApi {
  const fake = createFakeApi(overrides);
  (globalThis as unknown as { localcast: DesktopApi }).localcast = fake.api;
  return fake;
}
