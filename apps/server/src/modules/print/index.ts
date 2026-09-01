import { API_PREFIX } from '@localcast/contract';
import type { ServerModule } from '../../kernel.js';
import type { ExecFileFn } from './exec.js';
import type { PrintQueueOptions } from './jobs.js';
import { PrintQueue } from './jobs.js';
import { createPrintRouter } from './routes.js';

export interface PrintModuleOptions extends PrintQueueOptions {
  exec?: ExecFileFn;
  /** How stale the cached printer list may be before a read re-enumerates. */
  cacheTtlMs?: number;
}

export function createPrintModule(options: PrintModuleOptions = {}): ServerModule {
  let queue: PrintQueue | null = null;

  return {
    name: 'print',

    register(app, ctx) {
      queue = new PrintQueue(ctx, options);

      // Any job left `queued` or `printing` in the database belongs to a previous process.
      // Its spooler job is unreachable now — the queue diff that identified it is gone with
      // the process — so it is closed out honestly rather than left spinning for ever in
      // every client's job list.
      const stranded = ctx.db
        .prepare(
          `UPDATE print_jobs
              SET status = 'error',
                  error_message = 'The server restarted while this job was in the queue.',
                  finished_at = ?
            WHERE status IN ('queued', 'printing')`,
        )
        .run(Date.now());
      if (stranded.changes > 0) {
        ctx.log.info('closed stranded print jobs from a previous run', {
          count: stranded.changes,
        });
      }

      app.use(API_PREFIX, createPrintRouter(ctx, queue, options));
      ctx.log.info('print module registered');
    },

    async dispose() {
      await queue?.dispose();
    },
  };
}
