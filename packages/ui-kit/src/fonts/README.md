# Fonts

LocalCast is a Persian-first interface, so the typeface is not decoration — a missing font
leaves every Persian string in a fallback face with wrong metrics and broken joining.

## What is here

| File | Weight | Subset |
|------|--------|--------|
| `vazirmatn-300-arabic.woff2` | 300 | Arabic / Persian |
| `vazirmatn-300-latin-ext.woff2` | 300 | Latin Extended |
| `vazirmatn-300-latin.woff2` | 300 | Latin |

These are the exact files embedded in `LocalCast-standalone.html`, the design canvas this
product was drawn from, with the `unicode-range` declarations copied verbatim. The app
therefore renders in the same face and the same subsetting the design was reviewed in.

## What is not here

**Only weight 300 ships.** The canvas itself used nothing heavier, so headings and emphasis
are currently synthesised by the browser. That is a visible compromise on a dense UI, and it
is the first thing to fix if the typography looks soft.

To add 400, 500 and 600, take them from the upstream project and subset them the same way:

```bash
pyftsubset Vazirmatn-Regular.ttf \
  --output-file=vazirmatn-400-arabic.woff2 --flavor=woff2 \
  --layout-features='*' \
  --unicodes="U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0897-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC"
```

Two things that are easy to get wrong:

- **Keep `--layout-features='*'`.** Dropping it strips the GSUB tables that do Arabic
  joining, and every Persian word renders as disconnected letterforms.
- **Keep U+200C.** The zero-width non-joiner is load-bearing in ordinary Persian words —
  «انجام‌شده» is one of them, and it appears on the printing screen.

Then add a matching `@font-face` block to `../tokens.css`. The `unicode-range` values there
are the source of truth; copy them rather than retyping.

## Never load these from a CDN

`tokens.css` points at these local files on purpose. LocalCast is routinely reached from a
network with no internet egress — that is much of the point of the product — and a blocked
request to `fonts.googleapis.com` does not fail loudly. It silently leaves the interface in a
fallback face.

## Licence

Vazirmatn is released under the SIL Open Font License 1.1
(<https://github.com/rastikerdar/vazirmatn>). Redistribution is permitted; the OFL requires
the licence text to travel with the font files, so add `OFL.txt` to this directory alongside
them before shipping a build.
