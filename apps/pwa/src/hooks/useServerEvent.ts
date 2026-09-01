import { useEffect, useRef } from 'react';
import type { ServerEvent } from '@localcast/contract';
import { useClient } from '../client/ClientProvider.js';

/**
 * Subscribe to one kind of SSE event for as long as a component is mounted.
 *
 * The handler is held in a ref so a caller can pass an inline arrow function without
 * resubscribing on every render — resubscribing is cheap, but a print dialogue that
 * unsubscribes and resubscribes between two frames can miss the `done` event that arrives in
 * between, and then the job appears to hang for ever.
 */
export function useServerEvent<K extends ServerEvent['type']>(
  type: K,
  handler: (event: Extract<ServerEvent, { type: K }>) => void,
): void {
  const client = useClient();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    return client.events.on(type, (event) => {
      handlerRef.current(event as Extract<ServerEvent, { type: K }>);
    });
  }, [client, type]);
}
