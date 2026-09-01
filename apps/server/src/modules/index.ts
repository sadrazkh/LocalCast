import type { ServerModule } from '../kernel.js';
import { createPrintModule } from './print/index.js';
import { createUploadsModule } from './uploads/index.js';
import { createWebdavModule } from './webdav/index.js';

/**
 * The feature modules, in the order core registers them.
 *
 * WebDAV is first because it mounts on its own prefix with its own Basic auth and must not
 * end up behind the bearer-token middleware that guards `/api/v1`.
 */
export const modules: ServerModule[] = [
  createWebdavModule(),
  createPrintModule(),
  createUploadsModule(),
];

export { createWebdavModule } from './webdav/index.js';
export { createPrintModule } from './print/index.js';
export { createUploadsModule } from './uploads/index.js';
export type { WebdavModuleOptions } from './webdav/index.js';
export type { PrintModuleOptions } from './print/index.js';
export type { UploadModuleOptions } from './uploads/index.js';
