# LocalCast

Share folders, stream video and print from a Windows machine to your phone and other
desktops, without ever opening a port, entering an IP or installing a certificate.

**On your own Wi-Fi it needs no account.** Install it, point it at a folder, and a phone on
the same network reaches your library — no sign-in, no coordination server, no certificate
authority. Setup is: **install → choose a folder → type a four-character code on the phone**.

Reaching the machine from *somewhere else* is a switch you turn on, and the only part that
wants an account. It puts the machine on a private WireGuard mesh with a real Let's Encrypt
certificate on its own hostname, so nothing has to be exposed to the internet. Advanced users
can point the same install at their own self-hosted Headscale instead of Tailscale, and
switch back, without reinstalling.

**Every connection is encrypted, including on your own Wi-Fi.** On the local network the app
serves HTTPS on a certificate it generates for itself, so nothing else on the network can read
your files, your file names or the token your phone holds. Nothing is installed on the phone
to make that work — no certificate authority, no configuration profile.

The one honest cost is a single browser warning: the first time a device connects it asks
whether to trust this computer, because the connection is protected by the computer itself
rather than by an outside authority. Say yes once, per device. In exchange the origin is a
secure context, which is what the camera (scan the QR instead of typing the code) and the
service worker (the offline library) both require — neither of which the old plain-HTTP LAN
mode could offer at all.

**What each phone actually got, it now says.** Browsers differ on what they grant an origin
whose certificate the user accepted, so the app stops assuming: it records whether the service
worker registered, whether the context is secure, whether the camera API is exposed, and
reports those facts back. They appear on the phone's own **«این اتصال» / This connection**
panel and, through `GET /operator/capabilities`, in the Windows panel — so "this phone could
not install the offline library" is something the operator is told rather than something the
user discovers in an aeroplane. The report carries the capability record and nothing else: no
user agent, no version, no address it claims to be on.

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
- [Invariants](docs/invariants.md) — **read before changing a default, a listener or
  anything to do with `netedge`**: what "local by default" means, and the tests that hold it
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
- ~~`SumatraPDF.exe` in `vendor/bin`~~ — printing only, and **printing is switched off in this
  build**; see the note below
- Windows 10/11 for the server and printing; clients run anywhere

> **Printing is switched off in this build.** Nothing was deleted: the print module and its
> tests are intact, and the server answers its routes with a typed "this feature is off"
> rather than a 404. To bring it back, set `PRINTING_ENABLED` to `true` in all three of
> `apps/server/src/modules/features.ts`, `apps/desktop/src/shared/features.ts` and
> `scripts/features.mjs`, then rebuild.

## State of the build

`npm run build`, `npm test` and `npm run typecheck` are green: **606 tests** across seven
workspaces, plus five Go packages in `native/netedge`. CI runs the same on every push and the
release workflow runs it again before it will publish anything.

Proven on this machine: byte-exact range reads across the 4 GiB boundary against a real 5 GiB
sparse file; a flat descriptor count after 500 abandoned streams; instant token revocation;
the operator API refusing a non-loopback socket; a service worker that attaches the bearer to
media requests and to nothing cross-origin; the packaged app answering a phone on this
machine's own LAN address with no sign-in at all; and `netedge` reaching `login-required` with
a live sign-in URL.

Still **not** proven, and neither is a detail:

- **No Tailscale sign-in has been completed**, because that needs credentials. Everything up
  to the browser hand-off is exercised; the hop from `login-required` to `connected` is
  covered by unit tests and by reading the code, not by a live run. Nothing here has yet
  carried traffic over WireGuard.
- **No real device has connected.** Seeking a 4K file over cellular, printing from another
  network, the iOS Files app against the WebDAV mount, and switching between the default
  coordination server and a personal Headscale are all in
  [`docs/acceptance-checklist.md`](docs/acceptance-checklist.md), because only hardware can
  settle them.
- **The camera and the offline library have still not been observed on a real phone** behind an
  accepted certificate warning. The LAN listener genuinely speaks TLS — proven here by a real
  handshake — and an `https://` origin is a secure context, which is what both features
  require. What no test here can settle is how each browser treats a *self-signed* origin the
  user has clicked through: Chrome is documented to refuse service-worker registration on an
  origin with an outstanding certificate error, and Safari's behaviour on iOS is unchecked.
  What has changed is that the app no longer guesses. It records what it was granted and
  reports it, so E2 is now **run it and read the answer** rather than reason about it — see
  [`docs/acceptance-checklist.md`](docs/acceptance-checklist.md).

## If a browser will not take the certificate at all

There is an opt-in second listener on plain HTTP, off by default, for the narrow case where a
device cannot get *past* the certificate interstitial — an embedded webview with no "proceed"
affordance, a TV or kiosk browser, a managed configuration profile. It is not a repair for a
refused service worker and cannot be one: **`http://` is not a secure context anywhere except
loopback**, so a device on that address has no offline library and no camera at all. It is
strictly fewer capabilities than the HTTPS listener with an accepted warning, in exchange for
everyone else on the Wi-Fi being able to read the files and the token. That is the whole trade,
and it is stated in one sentence on the phone's own screen while it is in force.

What keeps it from becoming the quiet default: it needs `lan` as well as its own switch;
nothing advertises it — the QR code, the pairing screen and the published endpoint all keep
carrying the `https://` origin, so the only route onto it is a person reading the address off
the Windows panel and typing it; the operator API refuses it; and every device that uses it
appears in the capability report by name.

**About `.local` names.** A `.local` address buys a *stable, memorable* address that survives a
DHCP lease — which matters more than it sounds, because when the machine's address moves the
certificate no longer covers it, gets reissued, and every device meets the warning again. It
buys **nothing** about trust: a self-signed certificate for `localcast.local` is exactly as
untrusted as one for an IP. LocalCast adds no mDNS dependency and runs no responder, because it
does not need one — Windows 10/11 already publish `<hostname>.local` on the LAN, and that name
is already in the certificate. The panel offers it beside the IP; the IP stays the address in
the QR code, because `.local` resolution is native on iOS, macOS and Windows but has been
unreliable on Android.

## Before packaging

Drop `SumatraPDF.exe` into `vendor/bin` — see [`vendor/README.md`](vendor/README.md). Without
it everything works except printing, which fails with a message saying the print helper is
missing rather than pretending to queue. **Not needed while printing is switched off** —
`scripts/prepack.mjs` does not ask for it, and packaging without it warns about nothing.
