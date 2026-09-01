# Prerequisites

**نسخهٔ فارسی: [prerequisites.fa.md](prerequisites.fa.md)**

Everything LocalCast needs that `npm install` does not put there for you, why it needs it,
how to tell whether you have it, and exactly what to run.

From a fresh clone:

```bash
npm install     # also rebuilds the native modules for Electron — see §2
npm run doctor  # says what is missing and how to fix each one
npm start       # builds everything and launches the desktop app
```

| # | Prerequisite | Without it |
|---|--------------|-----------|
| 1 | Node 22+ and npm | nothing builds |
| 2 | `better-sqlite3` rebuilt for Electron | the app starts and dies at its first database call |
| 3 | Go 1.23+ → `netedge.exe` | **no access from outside the local network at all** |
| 4 | `SumatraPDF.exe` in `vendor/bin` | most images still print; PDFs print only if a reader is installed; copies, duplex and page ranges are refused |

Only 3 needs anything installed that most people do not already have, and it is the one that
matters most.

---

## 1. Node 22 or newer, and npm

**What it is.** The JavaScript runtime everything here is built with. npm ships with it.

**Why LocalCast needs it.** The server, both Electron apps and the PWA are all Node projects
in one npm workspace. `engines.node` is `>=22`, and the Vite configs use
`import.meta.dirname`, which does not exist on older runtimes — on Node 18 the failure reads
like a broken config file rather than an old Node.

**How to tell.**

```bash
node --version   # v22.x or newer
npm --version    # 10.x or newer
```

**How to get it.** Install the current LTS from <https://nodejs.org/en/download>. On Windows
the `.msi` installer includes npm and puts both on `PATH`. If you keep several versions
around, `nvm use 22` before working here.

---

## 2. The native-module rebuild

**What it is.** `better-sqlite3` is a C++ addon: a compiled `.node` file, not JavaScript. A
compiled addon is built against one specific ABI ("NODE_MODULE_VERSION"), and it will only
load in a runtime with that exact number.

**Why LocalCast needs it.** `npm install` compiles the addon against the ABI of the Node
binary that ran the install — 127 for Node 22. The desktop app does not run on that Node; it
runs on Electron 33, which embeds ABI 130. So the module npm just produced is the wrong shape
for the runtime that has to load it, and the app dies as soon as it opens the database:

```
Error: The module '\\?\C:\...\node_modules\better-sqlite3\build\Release\better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 127. This version of Node.js requires
NODE_MODULE_VERSION 130. Please try re-compiling or re-installing
the module (for instance, using `npm rebuild` or `npm install`).
```

**Take the last line of that message with a pinch of salt.** `npm install` and `npm rebuild`
are what put the module at 127 in the first place; running either again just rebuilds it for
Node and you are back where you started. The addon has to be built for *Electron*.

**How to tell.**

```bash
npm run doctor
```

It reports `better-sqlite3  built for Electron 33.4.11 (ABI 130)` when this is right, and
names both numbers when it is not.

**How to get it.**

```bash
npm run rebuild:native
```

That runs `@electron/rebuild` for the modules that need it, reading the Electron version from
the installed `electron` package rather than from a number typed into a script — so an
Electron upgrade does not silently reintroduce the problem. It is a no-op when the binding
already matches, which is why `npm start` runs it every time.

You should not normally have to think about this at all: the root `postinstall` runs the same
step, so a fresh `npm install` leaves you with a launchable tree. `postinstall` deliberately
does **not** fail the install if the rebuild fails — it prints what to run once you have
fixed the cause — because someone cloning this to run `npm test -w @localcast/server` should
not be blocked by a desktop toolchain they do not need.

**If the rebuild fails**, the usual cause on Windows is that no prebuilt binary exists for
this combination and the module has to be compiled from source, which needs the Visual Studio
**Build Tools** with the *Desktop development with C++* workload:
<https://visualstudio.microsoft.com/downloads/>. Install it, open a new terminal so `PATH`
is refreshed, and run `npm run rebuild:native` again.

**Packaged builds are not affected.** `electron-builder` rebuilds native modules as part of
packaging, so an installed LocalCast never sees this. It is purely a run-from-source problem.

---

## 3. Go 1.23 or newer

**What it is.** The Go toolchain, needed to compile `native/netedge` into `netedge.exe`.

**Why LocalCast needs it — read this one.** `netedge` is the network edge: a userspace
WireGuard node (`tailscale.com/tsnet`) that terminates TLS on the tailnet and reverse-proxies
to the Node server on loopback. **Without it there is no access from outside the local
network at all** — no tailnet, no certificate, no phone connecting over cellular, no printing
from another building. That is most of the product. The app still opens, still browses
folders and still shows you what is wrong, because a panel that cannot explain itself is
worse than one missing a feature; but nothing outside the machine can reach it.

Go is only needed to *produce* the binary. Once `netedge.exe` exists you can run LocalCast on
a machine with no Go on it, and end users never have it — the installer ships the compiled
sidecar.

**How to tell.**

```bash
go version                     # go1.23 or newer
ls native/netedge/netedge.exe  # the built sidecar
```

`npm run doctor` checks both, and treats a missing Go toolchain as a note rather than a
problem once the binary is there.

**How to get it.** Install Go from <https://go.dev/dl/> (the Windows `.msi` puts `go` on
`PATH`; open a new terminal afterwards), then:

```bash
npm run netedge:build   # go build -o netedge.exe ./cmd/netedge
npm run netedge:test
```

The first build in a fresh clone also has to resolve the module versions — `go.mod` was
written without a toolchain available and there is no `go.sum` yet. `native/netedge/README.md`
has the exact `go get` line for that, and explains the `VERIFY:` comments you should read
afterwards.

---

## 4. SumatraPDF in `vendor/bin`

**What it is.** A small, portable PDF viewer and printer. LocalCast invokes it as a
subprocess to submit print jobs.

**Why LocalCast needs it.** Printing is submitted with SumatraPDF's `-print-to` and
`-print-settings`, then tracked through the real Windows spooler. Bundling it is what makes
remote printing work regardless of what PDF reader the user happens to have. It is not
committed to this repository on purpose: a checked-in third-party executable is a licence and
review problem, and one downloaded automatically during a build is a supply-chain problem.

**What still prints without it — and what does not.** LocalCast falls back to the Windows
shell's `PrintTo` verb, which needs no bundled binary but can only hand a file to whichever
application owns its type. Measured on a real machine, not assumed:

| Without the helper | Result |
|---|---|
| `.png` `.jpg` `.jpeg` `.gif` `.tif` `.tiff` | print — Windows registers `printto` for these itself |
| `.bmp` `.webp` | **refused.** `.bmp` belongs to `Paint.Picture`, which never registered the verb, and `.webp` has no handler at all |
| `.pdf` with Acrobat, SumatraPDF or another reader installed | prints |
| `.pdf` on a clean Windows | **refused.** Edge is the default PDF handler and its ProgId `MSEdgePDF` exposes only `open` — it can show you a PDF but not print one from the shell |
| any job asking for copies, duplex or a page range | **refused**, whatever the type. `PrintTo` cannot express them, and printing one copy when two were asked for is worse than failing |

Every one of those refusals happens *before* anything is sent to the printer, and says which
of the two reasons applies. Nothing else depends on the helper: browsing, streaming, WebDAV
and uploads all work normally.

**How to tell.**

```bash
npm run doctor                  # says which types print here, and why the rest do not
node scripts/verify-vendor.mjs  # checks the installed binary against the recorded digest
```

`npm run doctor` reports `image printing` and `PDF printing` separately, because they fail for
different reasons and have different fixes.

**How to get it.**

```bash
node scripts/install-print-helper.mjs
```

That downloads the portable 64-bit build from
<https://www.sumatrapdfreader.org/dl/rel/3.5.2/SumatraPDF-3.5.2-64.zip>, unpacks it into
`vendor/.staging`, and prints the SHA-256 it computed, the size, and what Windows'
Authenticode check says about who signed it. Then it **stops**. Nothing reaches `vendor/bin`
until you run it again with the digest it showed you:

```bash
node scripts/install-print-helper.mjs --confirm=<the sha256 it printed>
```

**SumatraPDF publishes no checksum file.** There is no `SHA256SUMS` to compare against, which
is exactly why this is two steps instead of an automatic download: open
<https://www.sumatrapdfreader.org/download-free-pdf-viewer>, check that this is the release
you meant, and treat the Authenticode signature as the publisher-side evidence — the script
refuses to install anything Windows does not call `Valid` unless you pass `--allow-unsigned`.

On success it records the digest in `vendor/checksums.json`, so every later run — here, on
another machine, in CI — **verifies instead of trusting**. It will refuse to install a binary
whose digest does not match one already recorded. If you were given a digest out of band,
pass it as `--expect=<sha256>` and the script will abort before installing rather than after.

`vendor/README.md` covers the licence terms.

---

## The commands

| Command | What it does |
|---------|--------------|
| `npm install` | installs dependencies, then rebuilds native modules for Electron |
| `npm run doctor` | checks everything on this page; exits non-zero if something blocking is missing |
| `npm start` | rebuild check → full build → launch the desktop app |
| `npm run dev` | Vite for the Electron renderer (`:5174`) and the PWA (`:5173`), plus Electron pointed at the first |
| `npm run rebuild:native` | just the native-module rebuild |
| `node scripts/install-print-helper.mjs` | fetches SumatraPDF and shows you its digest; installs nothing without `--confirm` |
| `node scripts/verify-vendor.mjs` | checks the vendored binaries against `vendor/checksums.json` |
| `npm run netedge:build` | builds the Go sidecar (needs Go) |
| `npm run build` / `npm test` | the whole workspace |

`npm run dev` sets `VITE_DEV_SERVER_URL` to the **desktop** renderer's dev server, which is
what the main process reads to load the window from Vite instead of from disk. The PWA dev
server runs alongside it because in development the Node server does not serve the built PWA
— Vite does. The PWA's `/api` and `/dav` proxy points at `LOCALCAST_DEV_API`, defaulting to
`:8420`; the desktop app binds an ephemeral port, so set that variable if you want the two
talking to each other.
