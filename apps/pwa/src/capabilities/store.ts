import { useSyncExternalStore } from 'react';
import {
  applyServiceWorkerOutcome,
  initialCapabilities,
  isEncryptedTransport,
  readEnvironment,
  type CapabilityEnvironment,
  type DeviceCapabilities,
  type ServiceWorkerOutcome,
} from './detect.js';

/**
 * The one place the app keeps what it knows about its own capabilities.
 *
 * It is a module singleton rather than React state because the fact that matters most —
 * whether the service worker registered — is settled in `main.tsx`, outside the tree and
 * before the first render. A context would have to be told by something that lives above the
 * thing that knows. A store can be written from either side and read with
 * `useSyncExternalStore`, which is what keeps the screen and the report from disagreeing.
 */

export interface CapabilitySnapshot {
  capabilities: DeviceCapabilities;
  /** False when this page arrived over plain HTTP from somewhere other than loopback. */
  encryptedTransport: boolean;
}

export interface CapabilityStore {
  get(): CapabilitySnapshot;
  subscribe(listener: () => void): () => void;
  /** Called once, from wherever the registration attempt was made. */
  noteServiceWorker(outcome: ServiceWorkerOutcome): void;
}

export interface CreateCapabilityStoreOptions {
  environment?: CapabilityEnvironment;
  location?: { protocol: string; hostname: string };
}

export function createCapabilityStore(
  options: CreateCapabilityStoreOptions = {},
): CapabilityStore {
  const environment = options.environment ?? safeEnvironment();
  const location = options.location ?? safeLocation();

  let snapshot: CapabilitySnapshot = {
    capabilities: initialCapabilities(environment),
    encryptedTransport: isEncryptedTransport(location),
  };
  const listeners = new Set<() => void>();

  return {
    // The same object identity until something actually changes: `useSyncExternalStore` calls
    // this on every render and re-renders for ever if it is handed a fresh object each time.
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    noteServiceWorker(outcome) {
      const capabilities = applyServiceWorkerOutcome(snapshot.capabilities, outcome);
      if (capabilities.serviceWorker === snapshot.capabilities.serviceWorker) return;
      snapshot = { ...snapshot, capabilities };
      for (const listener of listeners) listener();
    },
  };
}

/** The app's store. Written by `main.tsx`, read by the screens and by the reporter. */
export const capabilityStore = createCapabilityStore();

export function useCapabilities(): CapabilitySnapshot {
  return useSyncExternalStore(
    (onChange) => capabilityStore.subscribe(onChange),
    () => capabilityStore.get(),
    // Server-rendering never happens here, but the third argument is what stops a bundler's
    // SSR shim from calling the browser reader in a place with no `window`.
    () => capabilityStore.get(),
  );
}

function safeEnvironment(): CapabilityEnvironment {
  if (typeof window === 'undefined') {
    return {
      secureContext: false,
      hasServiceWorker: false,
      hasMediaDevices: false,
      hasIndexedDb: false,
      standalone: false,
    };
  }
  return readEnvironment(window);
}

function safeLocation(): { protocol: string; hostname: string } {
  if (typeof window === 'undefined') return { protocol: 'https:', hostname: 'localhost' };
  return { protocol: window.location.protocol, hostname: window.location.hostname };
}
