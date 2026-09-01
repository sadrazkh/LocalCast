import { API_PREFIX } from '@localcast/contract';
import type { ServerModule } from '../../kernel.js';
import { createUploadRouter } from './routes.js';
import type { UploadServiceOptions } from './sessions.js';
import { UploadService } from './sessions.js';

export interface UploadModuleOptions extends UploadServiceOptions {
  /** Sessions untouched for longer than this are swept on boot. */
  abandonedAfterMs?: number;
}

export function createUploadsModule(options: UploadModuleOptions = {}): ServerModule {
  return {
    name: 'uploads',

    register(app, ctx) {
      const uploads = new UploadService(ctx, options);
      app.use(API_PREFIX, createUploadRouter(ctx, uploads));

      // Fire and forget: a slow temp directory must not hold up the server coming online,
      // and a sweep that fails is a disk-space problem for the next boot, not a reason to
      // refuse to serve anything.
      void uploads
        .sweepAbandoned(options.abandonedAfterMs)
        .catch((err: unknown) => ctx.log.warn('upload sweep failed', { error: String(err) }));

      ctx.log.info('uploads module registered');
    },
  };
}
