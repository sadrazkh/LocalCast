import type { ServerModule } from '../kernel.js';
import { PRINTING_ENABLED } from './features.js';
import { createPrintDisabledModule } from './print/disabled.js';
import { createPrintModule } from './print/index.js';
import { createUploadsModule } from './uploads/index.js';
import { createWebdavModule } from './webdav/index.js';

/**
 * The feature modules, in the order core registers them.
 *
 * WebDAV is first because it mounts on its own prefix with its own Basic auth and must not
 * end up behind the bearer-token middleware that guards `/api/v1`.
 *
 * Printing takes whichever of two shapes `PRINTING_ENABLED` selects. With it off, the real
 * module never registers — no `PrintQueue`, no spooler poll, no boot-time write to
 * `print_jobs` — and a small inert module answers those paths with a typed 503 instead. See
 * `./features.ts` for why this is a switch and not a deletion. WebDAV and uploads are
 * untouched either way: turning printing off must cost printing and nothing else.
 */
export const modules: ServerModule[] = [
  createWebdavModule(),
  PRINTING_ENABLED ? createPrintModule() : createPrintDisabledModule(),
  createUploadsModule(),
];

export { PRINTING_ENABLED } from './features.js';
export { createWebdavModule } from './webdav/index.js';
export { createPrintModule } from './print/index.js';
export { createPrintDisabledModule } from './print/disabled.js';
export { createUploadsModule } from './uploads/index.js';
export type { WebdavModuleOptions } from './webdav/index.js';
export type { PrintModuleOptions } from './print/index.js';
export type { UploadModuleOptions } from './uploads/index.js';
