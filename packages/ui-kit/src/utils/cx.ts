/**
 * Class-name join. Two lines rather than a `clsx` dependency: this package ships into an
 * Electron installer and a PWA, and a transitive dependency for string concatenation is not
 * worth the supply-chain surface.
 */
export type ClassValue = string | false | null | undefined;

export function cx(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ');
}
