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

Printing falls back to the Windows shell's `PrintTo` verb, which needs no bundled binary.
That covers more than it sounds like:

* **Images always work.** Windows itself registers `printto` for `.png`, `.jpg` and `.tif`
  (`rundll32 shimgvw.dll,ImageView_PrintTo`), so image printing needs nothing vendored.
* **PDFs work only if a reader registered the verb.** Acrobat and SumatraPDF do. **Edge — the
  default PDF handler on a clean Windows — does not**; its ProgId `MSEdgePDF` exposes only
  `open` and `runas`. So on a stock machine with no PDF reader installed, PDF printing still
  needs this binary.

The fallback can only pass a file and a printer. It cannot ask for **copies, duplex or a page
range**, so a job requesting any of those is refused with a message naming this file rather
than printed with the wrong settings — printing one copy when two were asked for, or four
hundred pages when page three was asked for, is worse than failing.

If neither the helper nor a `PrintTo` handler exists, the job fails with `spooler_failed`.
Everything else — browsing, streaming, WebDAV, uploads — works normally. The app does not
pretend a job was queued when there is nothing to queue it with.
