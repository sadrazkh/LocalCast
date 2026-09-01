import { useEffect, useState } from 'react';

/**
 * A hash router, because the three surfaces are three `BrowserWindow`s loading one bundle.
 *
 * `windows.ts` opens `index.html` with `{ hash: '/panel' }`, `'#/wizard'` or `'#/tray'`, and
 * in a packaged build that file is loaded over `file://` — where history-based routing has
 * no server to fall back to and a path-based route is a missing file. The hash is the only
 * thing that survives both the dev server and `loadFile`.
 */

export const PANEL_SECTIONS = [
  'hosting',
  'folders',
  'devices',
  'pairing',
  'settings',
  'activity',
] as const;

export type PanelSection = (typeof PANEL_SECTIONS)[number];

export type Route =
  | { kind: 'wizard' }
  | { kind: 'tray' }
  | { kind: 'panel'; section: PanelSection };

function isSection(value: string): value is PanelSection {
  return (PANEL_SECTIONS as readonly string[]).includes(value);
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/panel';
  if (path.startsWith('/wizard')) return { kind: 'wizard' };
  if (path.startsWith('/tray')) return { kind: 'tray' };

  const rest = path.replace(/^\/panel\/?/, '');
  // An unknown sub-route lands on the overview rather than on a blank pane. The hash is
  // written by the main process and by the tray menu, so a typo there should degrade to
  // something usable.
  return { kind: 'panel', section: isSection(rest) ? rest : 'hosting' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}

export function navigate(path: string): void {
  window.location.hash = path;
}
