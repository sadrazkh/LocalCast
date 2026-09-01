// @vitest-environment node
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { PRINTING_ENABLED } from '../../../shared/features.js';
import type { PrerequisiteStatus } from '../../../shared/preflight.js';
import { runPreflight, summarise } from '../run.js';

/**
 * The whole point of the severity split: a missing print helper costs the user printing, and
 * nothing else. It must never be the reason setup will not continue.
 */

const OK: PrerequisiteStatus = {
  id: 'netedge',
  severity: 'blocking',
  state: 'ok',
  searchedPaths: [],
  detail: '',
  remedies: [],
};

const BLOCKING_MISSING: PrerequisiteStatus = { ...OK, state: 'missing' };

const DEGRADING_MISSING: PrerequisiteStatus = {
  ...OK,
  id: 'print-helper',
  severity: 'degrading',
  state: 'missing',
};

describe('summarise', () => {
  it('refuses to proceed while a blocking prerequisite is outstanding', () => {
    const report = summarise([BLOCKING_MISSING, DEGRADING_MISSING], 1);

    expect(report.canProceed).toBe(false);
    expect(report.allSatisfied).toBe(false);
  });

  it('proceeds when only a degrading prerequisite is outstanding', () => {
    const report = summarise([OK, DEGRADING_MISSING], 1);

    expect(report.canProceed).toBe(true);
    // Still not everything: the wizard may continue, but printing is genuinely unavailable.
    expect(report.allSatisfied).toBe(false);
  });

  it('is satisfied only when every prerequisite is ok', () => {
    const report = summarise([OK, { ...DEGRADING_MISSING, state: 'ok' }], 1);

    expect(report.canProceed).toBe(true);
    expect(report.allSatisfied).toBe(true);
  });
});

describe('the prerequisites report while printing is switched off', () => {
  /**
   * A prerequisites screen is the list of things standing between the user and a working app.
   * With `PRINTING_ENABLED` false there is no route in the build that could use SumatraPDF, so
   * a row for it — green, amber or otherwise — is a question the user has to work out is not a
   * question. It must be absent, not merely satisfied.
   */
  it.runIf(!PRINTING_ENABLED)('says nothing at all about the print helper', async () => {
    // A directory with no vendor/bin in it: the detector, were it running, would report the
    // helper missing. Nothing here mocks it away — the point is that it is never asked.
    const report = await runPreflight(
      {
        appRoot: tmpdir(),
        resourcesPath: tmpdir(),
        repoRoot: tmpdir(),
        vendorDir: tmpdir(),
        nativeBinding: '',
      },
      { force: true },
    );

    expect(report.items.map((item) => item.id)).not.toContain('print-helper');
    // …and the rest of the screen is untouched: switching printing off costs printing only.
    // Asserted by presence rather than by the exact list, because the other prerequisites are
    // governed by their own flags in `shared/features.ts` and this test is not about those.
    expect(report.items.map((item) => item.id)).toContain('native-modules');
  });
});
