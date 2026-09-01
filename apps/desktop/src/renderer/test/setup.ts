/**
 * Without this React refuses to flush updates inside `act()` and warns instead. The warning
 * is not cosmetic: state set from an effect may never be applied, so an assertion about what
 * the screen says can pass against a component that never rendered.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { writable: true, value: true });

/**
 * jsdom does not implement these, and components that use them would otherwise throw inside
 * a render pass rather than failing on the thing under test.
 */
if (!('matchMedia' in globalThis)) {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

if (!('ResizeObserver' in globalThis)) {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    writable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
}
