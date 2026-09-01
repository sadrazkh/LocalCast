// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { PrerequisiteStatus } from '../../../shared/preflight.js';
import { summarise } from '../run.js';

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
