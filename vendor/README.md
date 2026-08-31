# Vendored binaries

LocalCast ships one third-party executable: **SumatraPDF**, which does the actual printing.

It is not committed to this repository, and the build does not download it automatically.
Both of those are deliberate: a binary that arrives without the maintainer looking at it is a
supply-chain problem, and a checked-in executable is a licence and review problem.

## What to place here

```
vendor/bin/SumatraPDF.exe
```

Use the **portable 64-bit** build from the official site:
<https://www.sumatrapdfreader.org/download-free-pdf-viewer>

SumatraPDF is GPLv3. Shipping it alongside LocalCast is fine as long as it stays a separate,
unmodified executable invoked as a subprocess — which is exactly how `modules/print/spooler.ts`
uses it. Do not statically link it and do not patch it.

## Recording and verifying the hash

The first time you place the binary, record its digest:

```bash
node scripts/verify-vendor.mjs --record
```

That writes the real SHA-256 of the file you actually downloaded into `vendor/checksums.json`.
Nothing invents a digest for you — a checksum that was not computed from a real file proves
nothing, and would happily pass every test while shipping the wrong binary.

Afterwards, and in CI, verify with:

```bash
node scripts/verify-vendor.mjs
```

Before recording, check the digest against the checksum the SumatraPDF project publishes with
the release. `--record` trusts the file in front of it; that check is yours to make.

## What happens if it is missing

Printing fails with `spooler_failed` and a message saying the print helper is missing.
Everything else — browsing, streaming, WebDAV, uploads — works normally. The app does not
pretend a job was queued when there is nothing to queue it with.
