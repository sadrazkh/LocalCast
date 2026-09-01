import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAV_PREFIX } from '@localcast/contract';
import { modules } from '../../src/modules/index.js';
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
    expect(modules.map((module) => module.name)).toEqual(['webdav', 'print', 'uploads']);
  });

  it('registers all three onto one app without colliding', async () => {
    const server = await harness.serve(modules);

    // The DAV mount answers on its own prefix with its own challenge…
    const dav = await fetch(`${server.url}${DAV_PREFIX}/anything`, { method: 'PROPFIND' });
    expect(dav.status).toBe(401);
    expect(dav.headers.get('www-authenticate')).toContain('Basic');

    // …while the API prefix answers the module routes, unauthenticated.
    const jobs = await fetch(`${server.url}/api/v1/print/jobs`);
    expect(jobs.status).toBe(401);
    const upload = await fetch(`${server.url}/api/v1/uploads/anything`);
    expect(upload.status).toBe(401);
  });
});
