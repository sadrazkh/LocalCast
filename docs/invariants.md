# Invariants

> **Read this before you change a default, a listener, or anything to do with `netedge`.**
> LocalCast is local-network-only unless a person has explicitly asked for more. If a change
> makes the app need an account, a coordination server, or the internet in order to do
> something it already did on the Wi-Fi, the change is wrong — no matter how much nicer the
> code is. The tests below are how that is enforced; do not weaken one to make a change pass.

## The promise

1. **The default is local.** No account, no coordination server, no traffic leaving the
   machine. Install it, point it at a folder, type a four-character code on the phone.
2. **Outside access is a switch.** Reaching the machine from another network is opt-in, and it
   is the only part of the product that wants an account.
3. **Switching control planes is not a reinstall.** Moving between the default Tailscale
   coordination server and a personal Headscale happens in the running process. No restart, no
   re-pairing, no database migration.

## What holds each part

| The rule | Where it lives | What holds it |
| --- | --- | --- |
| A fresh `ServerConfig` has `lan: false`; the core opens nothing but loopback unless told to | `apps/server/src/config.ts` | `apps/server/test/invariants.test.ts` → *the default server configuration* |
| A fresh `AppConfig` has `shareOnLan: true` and `remoteAccess: false`, including after a corrupt file | `apps/desktop/src/main/appConfig.ts` | `apps/desktop/src/main/__tests__/appConfig.test.ts` |
| The desktop is what turns the LAN listener on, from the user's stored preference | `apps/desktop/src/main/index.ts` (`bootstrap`) | `apps/desktop/src/main/__tests__/bootstrap.test.ts` → *still tells the server to share on the local network* |
| `remoteAccess: false` means the sidecar process is never spawned | `apps/desktop/src/main/index.ts` (the netedge gate) | `apps/desktop/src/main/__tests__/bootstrap.test.ts` → asserts on the **spawn**, with the `remoteAccess: true` case as its control |
| A missing `netedge` costs one feature and never blocks startup | `apps/desktop/src/main/preflight/detect.ts` (`NETEDGE_SEVERITY`) | `apps/desktop/src/main/__tests__/preflight.netedge.test.ts` |
| Nothing reaches the internet in the default configuration | everywhere | `apps/server/test/offline.test.ts` |
| Nothing reaches the internet while the desktop starts | `apps/desktop/src/main/index.ts` | `apps/desktop/src/main/__tests__/bootstrap.test.ts` → *contacts nothing on the internet while starting* |
| A control-plane switch leaves devices, pairings and permissions untouched | `apps/server/src/http/routes/operatorNetwork.ts` | `apps/server/test/invariants.test.ts` → *moving between the default coordination server and a personal Headscale*; and, column for column through the real IPC handler, `apps/desktop/src/main/__tests__/modeSwitch.test.ts` |
| A control-plane switch reconfigures the running sidecar rather than restarting it | `apps/desktop/src/main/netedge.ts` (`applyConfig`), `native/netedge/internal/edge/edge.go` (`Edge.Apply`) | `apps/desktop/src/main/__tests__/netedge.switch.test.ts` — no Go binary needed, so it holds on every checkout; `modeSwitch.test.ts` proves the same thing against the real sidecar but **skips when `netedge.exe` has not been built** |
| The LAN listener speaks TLS, and loopback still demands the edge secret | `apps/server/src/index.ts`, `apps/server/src/auth/middleware.ts` | `apps/server/test/lan.test.ts` |

## The offline test, and why it is written the way it is

`apps/server/test/offline.test.ts` monkey-patches `net.Socket.prototype.connect` and
`dns.lookup` inside the test process, boots a real server with `lan: true`, and drives the
whole device API — pair, list, range read, WebDAV, SSE — while recording every address the
process asked for. Anything outside loopback and the private ranges fails the test **by name**,
because "something contacted the internet" without a hostname is a red test with no lead.

It hooks the socket layer rather than `fetch` on purpose: a dependency that phones home, a font
pulled from a CDN and an update check firing unasked all look different at the library level and
identical at `connect`.

The file starts with three tests of the guard itself. Keep them. The first version of the guard
missed `net.connect`'s normalised-argument form and would have passed while a real outbound
socket went through; the self-tests are what caught it.

## Known gaps

- **`preflight/run.ts` contradicts `NETEDGE_SEVERITY`.** `detectAll` passes `'blocking'` as the
  fallback severity for the `netedge` item, so if that detector ever *throws*, the item comes
  back blocking and `canProceed` is false — the app refuses to start over a sidecar it does not
  need. The detector cannot throw today, so this is latent rather than live, and it is not
  covered by a test. The fallback should be `'degrading'`, in one place, shared with
  `detect.ts`.
- **The update checker fires unprompted on the Settings screen.** `checkForUpdate` is never
  called from `bootstrap` (held by a test), but `UpdatePanel` calls it from a `useEffect` on
  mount, so opening the panel's Settings section contacts `api.github.com` without the user
  asking for a check. It is one request, to a host the project owns a repository on, and it
  sends nothing but a user agent — but it is traffic leaving the machine that nobody asked for.
- **`Edge.Apply` has no Go-side test.** `native/netedge/internal/edge/edge_test.go` covers
  `watch` and the login paths, not `Apply`/`replace`. The restart-in-place property is asserted
  from outside — the sidecar process is not re-spawned across a switch — which proves the
  process survived but not that the *node* was rebuilt correctly inside it. A Go test driving
  `Apply` with a fake `localClient` is the missing piece.

## If you are about to change one of these

Say which of the three promises above your change affects, and how the change keeps it. If the
answer is "it doesn't, but the tests were in the way", the change does not land.
