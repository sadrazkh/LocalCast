import { routeAppShell } from './appShell.js';
import type { ShellDeps } from './appShell.js';
import { routeMedia } from './media.js';
import type { MediaFetchDeps } from './media.js';

export interface SwDeps extends MediaFetchDeps, ShellDeps {}

/**
 * The whole routing decision, in the order the branches must be tried.
 *
 * Media first, because `/api/v1/files/:id/content` is also an `/api/` path and the shell
 * branch would otherwise decline it and lose the bearer. Returning `null` means "this worker
 * does not answer that", and the caller must then not call `respondWith` at all — a service
 * worker that answers everything is a service worker that can break everything.
 */
export function routeRequest(request: Request, deps: SwDeps): Promise<Response> | null {
  return routeMedia(request, deps) ?? routeAppShell(request, deps);
}
