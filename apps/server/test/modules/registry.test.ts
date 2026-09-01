import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAV_PREFIX } from '@localcast/contract';
import { modules } from '../../src/modules/index.js';
import { PRINTING_ENABLED } from '../../src/modules/features.js';
import { PRINTING_DISABLED_CODE } from '../../src/modules/print/disabled.js';
import type { Harness } from './support/context.js';
import { createHarness } from './support/context.js';

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  for (const module of modules) await module.dispose?.();
  await harness.cleanup();
});

describe('the module registry', () => {
  it('exports the three feature modules, WebDAV first', () => {
    // WebDAV must be registered before anything that mounts under the API prefix, because it
    // carries its own Basic auth and must not end up behind the bearer-token middleware.
    //
    // The middle name follows `PRINTING_ENABLED`. Asserted rather than skipped: the switch's
    // whole job is to decide which of the two print modules registers, so the registry is the
    // one place that must state, out loud, which one it got. `print-disabled` is not the print
    // module — no queue, no spooler, no boot-time write — and the name says so.
    expect(modules.map((module) => module.name)).toEqual([
      'webdav',
      PRINTING_ENABLED ? 'print' : 'print-disabled',
      'uploads',
    ]);
  });

  it('registers all three onto one app without colliding', async () => {
    const server = await harness.serve(modules);

    // The DAV mount answers on its own prefix with its own challenge…
    const dav = await fetch(`${server.url}${DAV_PREFIX}/anything`, { method: 'PROPFIND' });
    expect(dav.status).toBe(401);
    expect(dav.headers.get('www-authenticate')).toContain('Basic');

    // …while the API prefix answers the module routes, unauthenticated. This holds with
    // printing switched off too: the stand-in checks authentication before it says anything
    // about the feature, so an unauthenticated prober learns nothing either way.
    const jobs = await fetch(`${server.url}/api/v1/print/jobs`);
    expect(jobs.status).toBe(401);
    const upload = await fetch(`${server.url}/api/v1/uploads/anything`);
    expect(upload.status).toBe(401);
  });

  it.runIf(!PRINTING_ENABLED)(
    'answers every print route with a typed "switched off", not a 404',
    async () => {
      const device = harness.addDevice();
      const server = await harness.serve(modules);
      const auth = { headers: { 'x-test-device': device.id } };

      // The whole point of registering a stand-in rather than nothing. A 404 here would be
      // indistinguishable from a broken mount and would send whoever met it hunting a bug that
      // does not exist; a 500 would claim LocalCast is broken. 503 says the server is fine and
      // this capability is not being served.
      const calls = [
        await fetch(`${server.url}/api/v1/printers`, auth),
        await fetch(`${server.url}/api/v1/print/jobs`, auth),
        await fetch(`${server.url}/api/v1/print/jobs/whatever`, auth),
        await fetch(`${server.url}/api/v1/print/jobs/whatever/cancel`, { method: 'POST', ...auth }),
        await fetch(`${server.url}/api/v1/print`, {
          method: 'POST',
          headers: { ...auth.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ printerId: 'x', source: { kind: 'library', fileId: 'y' } }),
        }),
      ];

      for (const response of calls) {
        expect(response.status).toBe(503);
        const body = (await response.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe(PRINTING_DISABLED_CODE);
        expect(body.error.message).toMatch(/switched off/i);
      }
    },
  );

  it.runIf(!PRINTING_ENABLED)('does not touch print_jobs while printing is off', async () => {
    // The real module closes out stranded jobs at registration, which means writing to the
    // database on boot. A switched-off feature must do nothing at all: no queue, no poll, no
    // migration-adjacent write to a table nothing is going to read.
    const device = harness.addDevice();
    const printer = harness.addPrinter();
    harness.ctx.db
      .prepare(
        `INSERT INTO print_jobs (id, device_id, printer_id, source_kind, source_path, file_name,
                                 status, created_at)
         VALUES ('stranded', ?, ?, 'library', 'C:\\a.pdf', 'a.pdf', 'queued', 1)`,
      )
      .run(device.id, printer.id);

    await harness.serve(modules);

    const row = harness.ctx.db
      .prepare(`SELECT status FROM print_jobs WHERE id = 'stranded'`)
      .get() as { status: string } | undefined;
    expect(row?.status).toBe('queued');
  });
});
