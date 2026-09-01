# LocalCast

Share folders, stream video and print remotely from a Windows machine to your phone and
other desktops — over a private WireGuard mesh, with a real certificate, and without the
user ever opening a port, entering an IP or installing a certificate.

For an ordinary user the whole setup is: **install → one click to sign in → scan a QR code**.
Advanced users can point the same install at their own self-hosted Headscale instead of
Tailscale, and switch back, without reinstalling.

## Layout

```
packages/
  contract/       API types and zod schemas — the single source of truth
  client-core/    transport, token storage, API client (no UI; Android reuses this)
  ui-kit/         shared React components, design tokens, fa/en i18n, RTL/LTR
apps/
  server/         Node + Express + SQLite; files, auth, WebDAV, printing
  desktop/        Electron: install wizard, tray, folders, device matrix, settings
  pwa/            React + Vite PWA — the iPhone client
  desktop-client/ Electron client for other Windows machines
native/
  netedge/        Go sidecar embedding tsnet: the network edge and TLS termination
docs/
  headscale/      self-hosted Headscale: compose file, setup script, walkthrough
```

## Documents

- [Prerequisites](docs/prerequisites.md) ([فارسی](docs/prerequisites.fa.md)) — what to
  install before this runs, why, and how to check
- [Design spec](docs/superpowers/specs/2026-09-01-localcast-design.md) — architecture, data
  model, API contract, and the constraints that shaped them
- [Design tokens](docs/design-tokens.md) — palette, type, shape, direction
- [Acceptance checklist](docs/acceptance-checklist.md) — the things only real hardware can
  prove

## Running it

```bash
npm install     # also rebuilds better-sqlite3 for Electron's ABI — see below
npm start       # builds everything, then launches the desktop app
```

```bash
npm run doctor  # what is missing, and the exact command that fixes each one
npm run dev     # Vite for both renderers, plus Electron pointed at the desktop one
npm run build && npm test
```

`npm install` compiles `better-sqlite3` against Node's ABI, and Electron embeds a different
one; without a rebuild the app dies at its first database call with
`NODE_MODULE_VERSION 127 ... requires 130`. The root `postinstall` handles it, `npm start`
re-checks it, and `npm run rebuild:native` does it on demand — nobody should have to know
this, which is why nothing here relies on you knowing it.

The Go sidecar builds separately, and **without it there is no access from outside the local
network at all**:

```bash
npm run netedge:build
```

## Requirements

Full detail, in English and Persian: [`docs/prerequisites.md`](docs/prerequisites.md) /
[`docs/prerequisites.fa.md`](docs/prerequisites.fa.md).

- Node 22+ and npm 10+
- Go 1.23+ — only to build `netedge`, but nothing reaches this machine from outside without it
- `SumatraPDF.exe` in `vendor/bin` — printing only; see [`vendor/README.md`](vendor/README.md)
- Windows 10/11 for the server and printing; clients run anywhere

## State of the build

`npm run build`, `npm test` and `npm run typecheck` are all green: **575 tests** across seven
workspaces (server 353, ui-kit 107, client-core 74, PWA 16, contract 16, panel 5, client 4).

Two things are deliberately *not* proven here, and neither is a detail:

- **`netedge` has never been compiled.** Go is not installed on the development machine, so
  the sidecar is written and reviewed but unbuilt. Nine `// VERIFY:` comments mark every
  upstream tsnet or certmagic API taken from documentation rather than from a compiler.
  Nothing in this repository has yet made a WireGuard connection.
- **No real device has connected.** Seeking a 4K file over cellular, printing from another
  network, the iOS Files app against the WebDAV mount, and switching between the default
  coordination server and a personal Headscale are all in
  [`docs/acceptance-checklist.md`](docs/acceptance-checklist.md), because only hardware can
  settle them.

What *is* proven on this machine: byte-exact range reads across the 4 GiB boundary against a
real 5 GiB sparse file, a flat descriptor count after 500 abandoned streams, instant token
revocation, the operator API refusing a non-loopback socket, and a service worker that
attaches the bearer to media requests and to nothing cross-origin.

Before packaging, drop `SumatraPDF.exe` into `vendor/bin` — see
[`vendor/README.md`](vendor/README.md). Without it everything works except printing, which
fails with a message saying the print helper is missing rather than pretending to queue.
