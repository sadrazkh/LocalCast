import { vi } from 'vitest';
import type { EdgeStatus, EdgeTestResult } from '@localcast/contract';
import type { DesktopApi } from '../../shared/ipc.js';
import type {
  PreflightReport,
  PrerequisiteId,
  PrerequisiteStatus,
} from '../../shared/preflight.js';
import type { PreflightApi } from '../preflight/api.js';

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

/**
 * Prerequisites, as the main process would report them once everything is in place.
 *
 * This is the default the fake answers with, so every test that is not about prerequisites
 * behaves as it did before the screen existed: the wizard skips it and opens on step one.
 */
export const ALL_SATISFIED: PreflightReport = {
  items: (['netedge', 'print-helper', 'native-modules'] as PrerequisiteId[]).map((id) => ({
    id,
    severity: id === 'print-helper' ? 'degrading' : 'blocking',
    state: 'ok',
    searchedPaths: [],
    detail: '',
    remedies: [],
  })),
  canProceed: true,
  allSatisfied: true,
  checkedAt: 0,
};

/**
 * `preflight` is overridable one method at a time — `Partial<DesktopApi>` alone would demand
 * the whole bridge. Tests deliberately install partial bridges, because the renderer
 * feature-detects each method and both states have to be reachable from a test.
 */
export type FakeApiOverrides = Omit<Partial<DesktopApi>, 'preflight'> & {
  preflight?: Partial<PreflightApi>;
};

export interface FakeApi {
  api: DesktopApi;
  /** Pushes a status frame to every subscriber, as the main process would. */
  emit(status: EdgeStatus): void;
  listeners: ((status: EdgeStatus) => void)[];
  /** Pushes one changed prerequisite, or a whole replacement report. */
  emitPreflight(payload: PrerequisiteStatus | PreflightReport): void;
  preflightListeners: ((payload: PrerequisiteStatus | PreflightReport) => void)[];
}

export function createFakeApi(overrides: FakeApiOverrides = {}): FakeApi {
  const listeners: ((status: EdgeStatus) => void)[] = [];
  const preflightListeners: ((payload: PrerequisiteStatus | PreflightReport) => void)[] = [];
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
    preflight: {
      run: vi.fn(async () => ALL_SATISFIED),
      install: vi.fn(async (id: PrerequisiteId) => ({
        ok: true as const,
        id,
        installedTo: `C:\\Users\\sara\\AppData\\Local\\LocalCast\\vendor\\${id}`,
      })),
      onProgress: (handler: (payload: PrerequisiteStatus | PreflightReport) => void) => {
        preflightListeners.push(handler);
        return () => {
          const i = preflightListeners.indexOf(handler);
          if (i >= 0) preflightListeners.splice(i, 1);
        };
      },
      openDoc: vi.fn(async () => undefined),
      runCommand: vi.fn(async (id: PrerequisiteId) => ({
        ok: true as const,
        id,
        installedTo: `C:\\Users\\sara\\AppData\\Local\\LocalCast\\vendor\\${id}`,
      })),
      ...overrides.preflight,
    },
  } as unknown as DesktopApi;

  return {
    api,
    listeners,
    preflightListeners,
    emit(next: EdgeStatus) {
      status = next;
      for (const listener of [...listeners]) listener(next);
    },
    emitPreflight(payload: PrerequisiteStatus | PreflightReport) {
      for (const listener of [...preflightListeners]) listener(payload);
    },
  };
}

export function installFakeApi(overrides: FakeApiOverrides = {}): FakeApi {
  const fake = createFakeApi(overrides);
  (globalThis as unknown as { localcast: DesktopApi }).localcast = fake.api;
  return fake;
}
