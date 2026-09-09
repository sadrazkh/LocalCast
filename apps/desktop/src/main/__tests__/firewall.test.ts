// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { FIREWALL_RULE_NAME, interpretFirewallRules, type FirewallRule } from '../firewall.js';

/**
 * The one cause of "it does not connect" the app could not see: Windows wrote a block rule
 * because somebody closed the first-run firewall prompt, and nothing anywhere said so.
 */

const EXE = 'C:\\Users\\sadra\\AppData\\Local\\Programs\\LocalCast\\LocalCast.exe';

function rule(overrides: Partial<FirewallRule>): FirewallRule {
  return { name: 'LocalCast', enabled: true, action: 'Allow', profile: 'Private', program: EXE, ...overrides };
}

describe('reading the firewall', () => {
  it('says blocked when Windows wrote a block rule for this program', () => {
    // Exactly what dismissing the prompt produces: two rules, TCP and UDP, both Block.
    const rules = [rule({ action: 'Block' }), rule({ action: 'Block' })];
    expect(interpretFirewallRules(rules, EXE)).toBe('blocked');
  });

  it('says blocked even with an allow rule beside the block, because the block wins in Windows too', () => {
    expect(interpretFirewallRules([rule({ action: 'Allow' }), rule({ action: 'Block' })], EXE)).toBe('blocked');
  });

  it('says allowed when the prompt was accepted', () => {
    expect(interpretFirewallRules([rule({ action: 'Allow' })], EXE)).toBe('allowed');
  });

  it('says allowed on the strength of the port rule this app writes, whatever the exe path', () => {
    // A portable build unpacks somewhere new every launch; the rule by port is what holds.
    const portRule = rule({ name: FIREWALL_RULE_NAME, program: null, action: 'Allow' });
    expect(interpretFirewallRules([portRule], 'C:\\Temp\\somewhere-else\\LocalCast.exe')).toBe('allowed');
  });

  it('ignores disabled rules', () => {
    expect(interpretFirewallRules([rule({ action: 'Block', enabled: false })], EXE)).toBe('no-rule');
  });

  it('compares program paths case-insensitively and across slash styles', () => {
    const odd = rule({ action: 'Block', program: EXE.toUpperCase().replace(/\\/g, '/') });
    expect(interpretFirewallRules([odd], EXE)).toBe('blocked');
  });

  it('does not let another copy of the app speak for this one', () => {
    // An older install, at another path, blocked. Windows matches on path, so this copy is not
    // actually blocked — but it is not allowed either, and the repair should be offered.
    const other = rule({ action: 'Block', program: 'C:\\Old\\LocalCast.exe' });
    expect(interpretFirewallRules([other], EXE)).toBe('no-rule');
  });

  it('says no rule when there is nothing', () => {
    expect(interpretFirewallRules([], EXE)).toBe('no-rule');
  });
});
