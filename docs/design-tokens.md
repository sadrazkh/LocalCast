# Design tokens

Extracted from `LocalCast-standalone.html`, the 16-screen design canvas. Every surface (PWA,
Windows panel, Windows client) uses these values. They are published as CSS custom
properties by `packages/ui-kit/src/tokens.css`; do not hard-code hex values in components.

The mockup is drawn at roughly 0.85 scale. Font sizes below are the **shipping** sizes
(mockup value × 1.15, rounded to the nearest 0.5px); everything else is used as drawn.

## Palette — dark, and dark only

The canvas has no light theme. Do not invent one.

### Surfaces, deepest to highest

| Token | Value | Used for |
|-------|-------|----------|
| `--lc-bg-abyss` | `#08090b` | page background behind everything |
| `--lc-bg-base` | `#0d0e12` | app shell, tray popover |
| `--lc-bg-surface` | `#12141a` | cards, panels, list containers |
| `--lc-bg-raised` | `#17191e` | rows, table headers, inputs |
| `--lc-bg-overlay` | `#1e2026` | modals, dropdowns, hover state |
| `--lc-bg-hover` | `#22252c` | row hover, pressed state |

### Text

| Token | Value | Used for |
|-------|-------|----------|
| `--lc-text-primary` | `#f2f3f5` | headings, file names, values |
| `--lc-text-secondary` | `#c9ced6` | body text |
| `--lc-text-muted` | `#8a8f98` | labels, metadata, column headers |
| `--lc-text-dim` | `#6f757f` | timestamps, secondary metadata |
| `--lc-text-faint` | `#5c626c` | disabled, placeholder |

### Lines

| Token | Value | Used for |
|-------|-------|----------|
| `--lc-border` | `#262931` | default border, table rules |
| `--lc-border-strong` | `#3a3d44` | focused input, active tab underline |
| `--lc-border-subtle` | `#1a1c21` | separators inside a surface |

### Accent and status

| Token | Value | Used for |
|-------|-------|----------|
| `--lc-accent` | `#4da3ff` | primary action, active nav, links, progress |
| `--lc-accent-hover` | `#7fbcff` | hover on accent |
| `--lc-accent-bg` | `#04121f` | accent-tinted surface (selected row) |
| `--lc-accent-border` | `#2f5d80` | border on accent surfaces |
| `--lc-accent-fg` | `#dbeaf7` | text on accent surfaces |
| `--lc-success` | `#3ddc97` | connected dot, "انجام‌شده", online device |
| `--lc-success-bg` | `#052b1c` | success chip background |
| `--lc-warning` | `#f0b429` | "در حال تلاش", pending approval, battery warning |
| `--lc-danger` | `#e0655f` | disconnected dot, "خطا", revoke, stop server |

Connection indicator: green `--lc-success` = متصل, red `--lc-danger` = قطع, amber
`--lc-warning` = در حال تلاش. Never expose transport detail next to the dot.

## Typography

- UI font: `Vazirmatn, system-ui, sans-serif` — self-hosted woff2, subset for Arabic +
  latin, weights 300/400/500/600. Never load it from Google Fonts at runtime; the server may
  be reached from a network with no internet egress.
- Monospace: `ui-monospace, SFMono-Regular, Menlo, monospace` — addresses, pairing codes,
  byte counts, uptime.

| Token | Size | Used for |
|-------|------|----------|
| `--lc-fs-display` | 24px | wizard step headings |
| `--lc-fs-title` | 16px | panel and section titles |
| `--lc-fs-body` | 15px | primary content, file names |
| `--lc-fs-sm` | 14.5px | table cells, secondary rows |
| `--lc-fs-xs` | 13px | labels, metadata |
| `--lc-fs-2xs` | 12px | chips, column headers, timestamps |

Persian numerals are used for user-facing counts and dates; ASCII digits stay for addresses,
byte sizes, codes and anything copyable. The `formatCount` / `formatAddress` helpers in
`ui-kit` enforce this split — do not call `toLocaleString` ad hoc.

## Shape and spacing

| Token | Value | Used for |
|-------|-------|----------|
| `--lc-radius-xs` | 2px | progress bars, tiny indicators |
| `--lc-radius-sm` | 6px | inputs, small buttons, chips |
| `--lc-radius-md` | 9px | cards, rows, modals — the dominant radius |
| `--lc-radius-lg` | 12px | panels, tray popover |
| `--lc-radius-xl` | 20px | pills, QR frame, avatars |

Spacing scale: 4 / 8 / 12 / 16 / 20 / 24 / 32.

## Direction

Both `fa` and `en` ship. Layout is written with logical properties
(`margin-inline-start`, `padding-inline`, `inset-inline`) so `dir="rtl"` flips it with no
per-component overrides. Icons that encode direction (back arrows, progress) mirror; media
controls, logos and the video timeline do not.

## Canvas layout references

- Windows surfaces are designed at **1000×640**.
- Mobile surfaces are designed at **393×852** (iPhone 15 logical size).
