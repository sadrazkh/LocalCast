# Vendored binaries

LocalCast ships one third-party executable: **SumatraPDF**, which does the actual printing.

It is not committed to this repository, and the build does not download it automatically.
Both of those are deliberate: a binary that arrives without the maintainer looking at it is a
supply-chain problem, and a checked-in executable is a licence and review problem.

## Installing it

```bash
node scripts/install-print-helper.mjs
```

That fetches the portable 64-bit build from the official host, unpacks it into
`vendor/.staging`, and prints what it got: the SHA-256 it computed, the byte count, and what
Windows' own Authenticode check says about who signed it. Then it stops. **Nothing reaches
`vendor/bin` until you run it again with the digest it showed you:**

```bash
node scripts/install-print-helper.mjs --confirm=<the sha256 it printed>
```

The confirmation flag is not a rubber stamp — it names specific bytes. If the staged file is
not those bytes, the install is refused.

### Why it cannot just install it

**SumatraPDF publishes no checksum.** There is no `SHA256SUMS`, no signed manifest, nothing to
compare a digest against. That absence is the entire reason for the two-step design: an
automatic download from a source that publishes nothing to verify it against is a
supply-chain problem dressed up as convenience.

What *does* exist is the Authenticode signature on the executable, which is the only
publisher-side evidence available. The script reports it and refuses to install a file
Windows does not call `Valid` unless you pass `--allow-unsigned`. Before you confirm, open
<https://www.sumatrapdfreader.org/download-free-pdf-viewer> and check that the release and
the build are the ones you meant.

### What it refuses

| Situation | What happens |
|---|---|
| no `--confirm` | stages, reports, installs nothing, exits 0 |
| `--confirm` does not match the staged file | refused, nothing installed |
| `--expect=<sha256>` given and does not match | refused before installing, not after |
| the digest differs from the one in `vendor/checksums.json` | refused — the second machine **verifies**, it does not trust |
| Authenticode is not `Valid` | refused unless `--allow-unsigned` |
| `vendor/bin/SumatraPDF.exe` already exists | refused unless `--force` |

Other flags: `--from=<path>` uses a file you already downloaded instead of fetching one,
`--url=` and `--version=` point at a different release.

## The digest, afterwards

A successful install records the SHA-256 in `vendor/checksums.json`. It is recorded from a
file that exists, never from a string somebody typed: a checksum that was not measured passes
every test and proves nothing. Verify at any time, and in CI, with:

```bash
node scripts/verify-vendor.mjs
```

`node scripts/verify-vendor.mjs --record` still exists for a binary you placed by hand. It
trusts the file in front of it; the checking is yours to do.

## Licence

SumatraPDF is GPLv3. Shipping it alongside LocalCast is fine as long as it stays a separate,
unmodified executable invoked as a subprocess — which is exactly how `modules/print/spooler.ts`
uses it. Do not statically link it and do not patch it.

## What happens if it is missing

Printing falls back to the Windows shell's `PrintTo` verb, which needs no bundled binary. What
that covers was measured on a real machine rather than assumed, and LocalCast now *reads* it
per job from the registry instead of guessing:

* **Most images print.** Windows registers `printto` for `.png`, `.jpg`, `.jpeg`, `.gif`,
  `.tif` and `.tiff` (`rundll32 shimgvw.dll,ImageView_PrintTo`), so those need nothing
  vendored at all.
* **`.bmp` and `.webp` do not.** `.bmp` resolves to `Paint.Picture`, which never registered
  the verb; `.webp` has no handler at all on a stock install. A job for either is refused
  before anything is spooled, naming the type.
* **PDFs work only if a reader registered the verb.** Acrobat and SumatraPDF do. **Edge — the
  default PDF handler on a clean Windows — does not**; its ProgId `MSEdgePDF` exposes only
  `open` and `runas`. So on a stock machine with no PDF reader installed, PDF printing still
  needs this binary.

The fallback can only pass a file and a printer. It cannot ask for **copies, duplex or a page
range**, so a job requesting any of those is refused with a message naming this file rather
than printed with the wrong settings — printing one copy when two were asked for, or four
hundred pages when page three was asked for, is worse than failing.

`npm run doctor` reports all of this for the machine it runs on: whether images will print,
whether PDFs will, and which of the two reasons applies.

If a type has a handler but the shell still fails to launch it, the job fails with
`spooler_failed`. Everything else — browsing, streaming, WebDAV, uploads — works normally. The
app does not pretend a job was queued when there is nothing to queue it with.
