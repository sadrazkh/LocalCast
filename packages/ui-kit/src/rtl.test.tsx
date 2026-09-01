import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LocaleProvider } from './i18n/index.js';
import { Switch } from './components/Switch.js';
import { Tabs } from './components/Tabs.js';

// `fileURLToPath`, not `new URL(...).pathname` — the latter leaves a leading slash in front
// of the Windows drive letter, and a drive-relative path silently resolves against the
// process's per-drive cwd instead of failing.
const SRC = dirname(fileURLToPath(import.meta.url));

function walk(dir: string, match: RegExp, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, match, found);
    else if (match.test(entry.name)) found.push(path);
  }
  return found;
}

/** Comments explain *why* a physical property was avoided, and several quote one. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Physical, direction-encoding declarations. Each of these produces a layout that is right
 * in one language and wrong in the other, which is exactly the class of bug a Persian-first
 * product cannot afford to ship.
 *
 * Deliberately *not* on this list: `transform: scaleX(-1)`, which `icons/icon.module.css`
 * applies under `[dir='rtl']` to the handful of icons that encode direction. That is the
 * one place a physical flip is the correct answer.
 */
const FORBIDDEN: readonly { name: string; pattern: RegExp }[] = [
  { name: 'margin-left / margin-right', pattern: /(^|[\s{;])margin-(left|right)\s*:/im },
  { name: 'padding-left / padding-right', pattern: /(^|[\s{;])padding-(left|right)\s*:/im },
  { name: 'border-left / border-right', pattern: /(^|[\s{;])border-(left|right)[\w-]*\s*:/im },
  { name: 'border-*-left-radius', pattern: /border-(top|bottom)-(left|right)-radius\s*:/im },
  { name: 'left / right insets', pattern: /(^|[\s{;])(left|right)\s*:/im },
  { name: 'text-align: left|right', pattern: /text-align\s*:\s*(left|right)\b/im },
  { name: 'float / clear', pattern: /(float|clear)\s*:\s*(left|right)\b/im },
  {
    name: 'scroll-margin/padding-left|right',
    pattern: /scroll-(margin|padding)-(left|right)\s*:/im,
  },
];

/** The camelCase equivalents, for inline styles in TSX. */
const FORBIDDEN_INLINE: readonly { name: string; pattern: RegExp }[] = [
  { name: 'marginLeft / marginRight', pattern: /\bmargin(Left|Right)\s*:/m },
  { name: 'paddingLeft / paddingRight', pattern: /\bpadding(Left|Right)\s*:/m },
  { name: 'borderLeft / borderRight', pattern: /\bborder(Left|Right)[\w]*\s*:/m },
  { name: 'left / right', pattern: /\bstyle=\{\{[^}]*\b(left|right)\s*:/m },
];

describe('direction: the kit is written in logical properties', () => {
  const stylesheets = walk(SRC, /\.module\.css$/);

  it('finds the CSS modules to scan', () => {
    // A scan that silently matched nothing would pass forever while proving nothing.
    expect(stylesheets.length).toBeGreaterThan(25);
  });

  it('has no physical directional declaration in any CSS module', () => {
    const offenders: string[] = [];

    for (const file of stylesheets) {
      const css = stripComments(readFileSync(file, 'utf8'));
      for (const rule of FORBIDDEN) {
        // Re-run per line so the report names the line, not just the file.
        css.split('\n').forEach((line, index) => {
          if (rule.pattern.test(line)) {
            offenders.push(`${relative(SRC, file)}:${index + 1} — ${rule.name} — ${line.trim()}`);
          }
        });
      }
    }

    expect(offenders).toEqual([]);
  });

  it('actually uses the logical equivalents, rather than avoiding the axis altogether', () => {
    const all = stylesheets.map((file) => stripComments(readFileSync(file, 'utf8'))).join('\n');
    expect(all).toMatch(/margin-inline-(start|end)\s*:/);
    expect(all).toMatch(/padding-inline\s*:/);
    expect(all).toMatch(/inset-inline-(start|end)\s*:/);
    expect(all).toMatch(/border-inline-(start|end)\s*:/);
    expect(all).toMatch(/text-align\s*:\s*(start|end)\b/);
  });

  it('has no physical directional inline style in any component', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC, /\.tsx$/)) {
      if (file.endsWith('.test.tsx')) continue;
      const source = readFileSync(file, 'utf8');
      for (const rule of FORBIDDEN_INLINE) {
        if (rule.pattern.test(source)) {
          offenders.push(`${relative(SRC, file)} — ${rule.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('mirrors direction-encoding icons and nothing else', () => {
    const iconCss = readFileSync(join(SRC, 'icons', 'icon.module.css'), 'utf8');
    // The flip is scoped to `.mirror` under an RTL ancestor — never to `.icon` itself,
    // which would reverse the play triangle and the logo along with the back arrow.
    expect(iconCss).toMatch(/\[dir='rtl'\]\)?\s*\.mirror/);
    expect(stripComments(iconCss)).not.toMatch(/\.icon\s*\{[^}]*scaleX/);
  });
});

describe('direction: the document follows the locale', () => {
  it('sets lang and dir on the document element for Persian', () => {
    render(
      <LocaleProvider locale="fa">
        <Switch checked onChange={() => undefined} label="نمایه‌سازی خودکار" />
      </LocaleProvider>,
    );
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('fa');
  });

  it('sets them to ltr/en for English', () => {
    render(
      <LocaleProvider locale="en">
        <Switch checked onChange={() => undefined} label="Automatic indexing" />
      </LocaleProvider>,
    );
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
  });

  it('marks the .lc-root element itself, so a portal-free subtree is correct too', () => {
    const { container } = render(
      <LocaleProvider locale="fa">
        <span>محتوا</span>
      </LocaleProvider>,
    );
    const root = container.querySelector('.lc-root');
    expect(root?.getAttribute('dir')).toBe('rtl');
    expect(root?.getAttribute('lang')).toBe('fa');
  });

  it('flips the keyboard axis with the direction, not just the paint', () => {
    // Tabs reads `dir` from the context; this is the behavioural half of the same rule the
    // stylesheet scan covers statically.
    const items = [
      { id: 'a', label: 'کتابخانه' },
      { id: 'b', label: 'جست‌وجو' },
    ];
    render(
      <LocaleProvider locale="fa">
        <Tabs items={items} value="a" onChange={() => undefined} label="ناوبری" />
      </LocaleProvider>,
    );
    expect(screen.getByRole('tab', { name: 'کتابخانه' }).getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: 'جست‌وجو' }).getAttribute('tabindex')).toBe('-1');
  });
});
