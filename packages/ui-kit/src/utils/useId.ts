import { useId as useReactId } from 'react';

/**
 * `useId` with a readable prefix. React's own ids contain `:` characters, which are legal in
 * an `id` attribute but not in a CSS selector, and several tests and `querySelector` calls
 * downstream would trip over them. Sanitising once here is cheaper than each caller
 * discovering it.
 */
export function useDomId(prefix: string): string {
  const raw = useReactId();
  return `${prefix}-${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}
