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

- [Design spec](docs/superpowers/specs/2026-09-01-localcast-design.md) — architecture, data
  model, API contract, and the constraints that shaped them
- [Design tokens](docs/design-tokens.md) — palette, type, shape, direction
- [Acceptance checklist](docs/acceptance-checklist.md) — the things only real hardware can
  prove

## Development

```bash
npm install
npm run build
npm test
```

The Go sidecar builds separately:

```bash
npm run netedge:build
```

## Requirements

- Node 22+
- npm 10+
- Go 1.23+ (only to build `netedge`)
- Windows 10/11 for the server and printing; clients run anywhere
