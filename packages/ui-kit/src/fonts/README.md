# Vazirmatn — drop the woff2 files here

The font binaries are **not committed**. `tokens.css` declares eight `@font-face` rules that
point at this directory, so until the files are here every Persian string renders in the
system fallback face.

## Why self-hosted and not Google Fonts

The Windows server is routinely reached from a network with no internet egress. A blocked
request to `fonts.googleapis.com` does not fail loudly — it silently leaves the whole UI in a
fallback face, which for Persian text means wrong metrics, wrong joining behaviour and a
layout that no longer matches the design canvas. There is no runtime CDN reference anywhere
in this package, and there must never be one.

## Files `tokens.css` expects

Exactly these eight names, in this directory:

| File | Weight | Subset |
|------|--------|--------|
| `Vazirmatn-Light-arabic.woff2` | 300 | Arabic |
| `Vazirmatn-Light-latin.woff2` | 300 | Latin |
| `Vazirmatn-Regular-arabic.woff2` | 400 | Arabic |
| `Vazirmatn-Regular-latin.woff2` | 400 | Latin |
| `Vazirmatn-Medium-arabic.woff2` | 500 | Arabic |
| `Vazirmatn-Medium-latin.woff2` | 500 | Latin |
| `Vazirmatn-SemiBold-arabic.woff2` | 600 | Arabic |
| `Vazirmatn-SemiBold-latin.woff2` | 600 | Latin |

Only weights 300/400/500/600 are used. Do not add 700+ faces: the design canvas never goes
heavier than SemiBold, and an unused weight is dead download weight in the installer.

## Which subsets

Two `unicode-range` groups are declared, and they must match what you actually subset:

- **arabic** — `U+0600-06FF`, `U+0750-077F`, `U+0870-088E`, `U+0890-0891`, `U+0898-08E1`,
  `U+08E3-08FF`, `U+200C-200E`, `U+2010-2011`, `U+204F`, `U+2E41`, `U+FB50-FDFF`,
  `U+FE70-FEFF`.

  `U+200C` (ZWNJ) is load-bearing: Persian compounds such as «انجام‌شده» and «جست‌وجو» use
  it, and a subset that drops it renders them joined and wrong.

  `U+06F0-06F9` (Persian digits) sit inside `U+0600-06FF` and are required — `formatCount`
  and `formatDate` emit them.

- **latin** — `U+0000-00FF`, `U+0131`, `U+0152-0153`, `U+02BB-02BC`, `U+02C6`, `U+02DA`,
  `U+02DC`, `U+2000-206F`, `U+2074`, `U+20AC`, `U+2122`, `U+2191`, `U+2193`, `U+2212`,
  `U+2215`, `U+FEFF`, `U+FFFD`.

## Getting them

Vazirmatn is released under the SIL Open Font License 1.1 by Saber Rastikerdar
(<https://github.com/rastikerdar/vazirmatn>). Download a release tarball on a machine that
does have internet, then either use the pre-subset `webfonts` build or subset it yourself:

```sh
# pip install fonttools brotli
pyftsubset Vazirmatn-Regular.ttf \
  --output-file=Vazirmatn-Regular-arabic.woff2 \
  --flavor=woff2 --layout-features='*' \
  --unicodes='U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0898-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FEFF'

pyftsubset Vazirmatn-Regular.ttf \
  --output-file=Vazirmatn-Regular-latin.woff2 \
  --flavor=woff2 --layout-features='*' \
  --unicodes='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
```

Keep `--layout-features='*'`. Arabic shaping lives in `init`/`medi`/`fina`/`rlig`; a subset
built with the default feature set drops them and the text renders as disconnected letters.

Ship the OFL licence file alongside the binaries.
