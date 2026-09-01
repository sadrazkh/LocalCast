# netedge

LocalCast's network edge: a userspace WireGuard node that terminates TLS on the tailnet and
reverse-proxies to the Node server on loopback.

It runs as an ordinary child process of the Electron app. **No UAC prompt, no Windows
service, no TUN driver** — that constraint is what makes "install and click once" possible,
and it is why the tailnet is embedded (`tailscale.com/tsnet`) rather than delegated to an
installed Tailscale client.

```
iPhone ──WireGuard/DERP──▶ netedge.exe (:443 on the tailnet, TLS terminated)
                                │  reverse proxy, injects x-lc-edge-secret + x-lc-peer
                                ▼
                           Node server on 127.0.0.1:<ephemeral>
```

See section 2 of [the design spec](../../docs/superpowers/specs/2026-09-01-localcast-design.md)
for the reasoning, and [`packages/contract/src/netedge.ts`](../../packages/contract/src/netedge.ts)
for the wire shapes. `internal/protocol/protocol.go` mirrors that file field for field and a
test on each side asserts the JSON round-trips.

## Building

**Go must be installed to build this.** Nothing else in the repository needs it, and the
Node build does not compile it — `npm run netedge:build` just shells out to `go`.

```bash
go build -o netedge.exe ./cmd/netedge   # from native/netedge
go test ./...
```

or from the repository root:

```bash
npm run netedge:build
npm run netedge:test
```

Requires Go 1.23 or newer.

### First build: resolve the dependency versions

`go.mod` was written without a Go toolchain available, so its versions are unverified
placeholders and there is no `go.sum`. Resolve them once:

```bash
go get tailscale.com@latest github.com/caddyserver/certmagic@latest \
       github.com/libdns/cloudflare@latest github.com/libdns/digitalocean@latest \
       github.com/libdns/route53@latest github.com/libdns/gandi@latest
go mod tidy
```

Search the source for `VERIFY:` afterwards. Each one marks a place where an upstream API
signature was written from documentation rather than checked against the compiler — mostly
in `internal/edge/cert.go` (certmagic's DNS-01 solver shape and the libdns provider field
names) and `internal/edge/edge.go` (tsnet's `LocalClient` return type, which moved packages
around tailscale v1.80).

## Flags

| Flag | Required | Meaning |
|------|:--------:|---------|
| `--state-dir <path>` | yes | Tailnet node state, the ACME certificate cache and, by default, the config file |
| `--upstream <host:port>` | yes | The loopback LocalCast server to reverse-proxy to |
| `--shared-secret <hex>` | yes* | Injected as `x-lc-edge-secret`; at least 16 bytes of hex |
| `--config <path>` | no | Config file; defaults to `<state-dir>/netedge.json` |
| `--control-port <n>` | no | Loopback control API port; `0` (default) lets the OS choose |
| `--log-level <level>` | no | Lowest level emitted as a `log` event: `debug`, `info` (default), `warn`, `error` |

\* Prefer the `LOCALCAST_EDGE_SECRET` environment variable, which takes precedence over the
flag. A command line is readable by every process on the machine through the process list,
and this secret is the Node server's proof that a request came through the edge.

Example:

```
netedge.exe --state-dir "%LOCALAPPDATA%\LocalCast\edge" ^
            --upstream 127.0.0.1:49512 ^
            --control-port 0
```

## The stdout protocol

`netedge` writes **newline-delimited JSON** to stdout and nothing else; fatal startup errors
go to stderr as plain text. Every line matches `edgeStdoutEventSchema`:

```json
{"type":"ready","controlPort":45123}
{"type":"status","status":{"state":"connecting","host":null,"funnelUrl":null,"loginUrl":null,"errorCode":null,"errorMessage":null,"certExpiresAt":null,"peers":0,"updatedAt":1756684800000}}
{"type":"log","level":"info","message":"tailnet node is running as localcast.tail1234.ts.net"}
```

- `ready` is emitted **first**, before anything slow, and carries the port the control API
  actually bound to. Until Electron has it there is no way to reach netedge at all — including
  to fix a configuration that will not start.
- `status` is a full snapshot, never a delta, so a consumer that misses one is still correct
  after the next.
- `log` respects `--log-level`.

`SIGINT` and `SIGTERM` both trigger a clean shutdown: the control API stops accepting, the
tsnet node is closed, a final `stopped` status is emitted, and the process exits 0.

## The control API

Loopback only (`127.0.0.1`), and every request must carry the shared secret in
`x-lc-edge-secret`. Requests whose `Host` header is not a loopback name are refused as well,
as a second lock against DNS rebinding.

| Route | Method | Purpose |
|-------|--------|---------|
| `/edge/status` | GET | Current `EdgeStatus` |
| `/edge/status/stream` | GET | Server-sent events; the current status first, then every change |
| `/edge/config` | GET | The configuration **without** its secrets |
| `/edge/config` | PUT | Validate, apply in place, then persist |
| `/edge/test` | POST | Dry run against a candidate configuration; always 200, the verdict is the body |
| `/edge/login` | POST | `{"loginUrl": "..."}` — Electron opens it; netedge never launches a browser |
| `/edge/logout` | POST | 204 |
| `/edge/restart` | POST | 202; rebuild the current configuration |

Failures use the same `{"error":{"code","message"}}` envelope as the device API, with codes
from `packages/contract/src/errors.ts`.

## Modes and certificates

| Mode | Control plane | Certificate | Funnel |
|------|---------------|-------------|--------|
| `default` | Tailscale | `control-plane` (`LocalClient.CertPair`), zero input | available |
| `custom` | your Headscale | `external-proxy` or `dns01` | **not available** |

**Headscale cannot issue certificates.** Issuance needs the control server to implement
`/machine/set-dns` and write the ACME TXT records for the base domain; Headscale has not
([#2527](https://github.com/juanfont/headscale/issues/2527),
[#2137](https://github.com/juanfont/headscale/issues/2137)), and Funnel is likewise
unimplemented ([#1040](https://github.com/juanfont/headscale/issues/1040)). `custom` +
`control-plane` and `custom` + `funnel` are therefore refused at three layers — config
validation, the `/edge/test` dry run, and certificate construction — because that
combination otherwise starts perfectly, connects perfectly, and then serves nothing,
presenting to the user as a "connecting…" spinner that never resolves.

The three strategies:

- **`control-plane`** — the local Tailscale daemon supplies the certificate. Nothing is asked
  of the user. `default` mode only.
- **`external-proxy`** — netedge serves **plain HTTP** on the tailnet address and your Caddy /
  Traefik / nginx terminates TLS in front of it. It never falls back to a self-signed
  certificate: a browser taught to click through a warning for LocalCast has been taught to
  click through warnings.
- **`dns01`** — netedge runs its own ACME client against a domain you own, proving control
  through a DNS TXT record. Certificates are cached under `<state-dir>/certs/acme` and renewed
  automatically. Supported providers: `cloudflare`, `digitalocean`, `route53`, `gandi`.

  Every provider except Route 53 authenticates with a single bearer token. **Route 53 needs a
  key pair, so `dnsApiToken` is read as `accessKeyId:secretAccessKey`.**

All three listen on tailnet port **443**, including `external-proxy` where the traffic is
plain HTTP. One port across all strategies means the pairing QR payload, the stored pairing
records and the operator's proxy configuration do not have to change when the certificate
strategy does.

## Header injection

Every proxied request reaches the Node server with:

- `x-lc-edge-secret` — the shared secret, so the loopback server can prove the request came
  through the edge rather than from another process pointing a browser at localhost.
- `x-lc-peer` — the tailnet peer identity, resolved through `WhoIs` and cached briefly per
  node. Behind Funnel there is no identity, so the literal `funnel` is injected; that is also
  the fallback whenever `WhoIs` cannot answer, so the server's rate limiter sees one shared
  "unidentified" bucket rather than an invented identity it might trust.

**Both headers are stripped from the inbound request before either is injected.** A client
cannot forge either one. `internal/edge/proxy_test.go` asserts this across every casing and
duplication trick, because `Header.Del` is canonicalising and a hand-rolled map delete would
not be.

## Secrets

The Headscale pre-authentication key and the DNS API token live encrypted under Electron's
`safeStorage` (Windows DPAPI) and are handed to netedge already decrypted, in the
`PUT /edge/config` body.

- `config.Save` strips both before writing, so `netedge.json` never contains a plaintext
  secret; `config.Load` drops any it finds, rather than adopting a credential that never went
  through DPAPI.
- `NetworkConfig.String()` redacts both, so `%v` on a config — including one embedded in a
  wrapped error — cannot leak one into a log.
- `GET /edge/config` answers with the secrets **absent**, not redacted. A settings page that
  read back `[redacted]`, edited one field and PUT the object back would otherwise store the
  placeholder as the auth key; `Validate` refuses that value for the same reason.

## Restart in place

Applying a new configuration tears the tsnet server down and brings a new one up **without
exiting the process** (design spec 2.4). Switching between the default coordination server
and a personal Headscale must not require reinstalling, and the SQLite database — devices,
permissions, pairings — is untouched by it.

Each control plane gets its own state directory under `<state-dir>/tsnet/`. A tsnet node key
is only meaningful to the control server that issued it, so sharing one directory across a
switch to Headscale and back would destroy the Tailscale identity and force a fresh login
every time the user changed their mind.

## Interactive login

When the control server wants a browser login, netedge publishes state `login-required` with
the auth URL and keeps polling until the node reports `Running`, then publishes `connected`.
**Electron opens the URL.** netedge runs headless as a child process and has no business
deciding what the user's screen does.

A key can also expire *after* the node has connected, and signing out does the same thing on
purpose. The connected node's watcher polls the daemon every thirty seconds and publishes
`login-required` again when that happens, so the tray never shows a green dot for a node that
has stopped carrying traffic; when the node is signed in again it publishes `connected` and
the listener, which was never torn down, goes on serving.

## Layout

```
cmd/netedge/        flags, the stdout emitter, signal handling, wiring
internal/protocol/  the Go mirror of netedge.ts
internal/config/    load/save, and the rule that no plaintext secret is written
internal/edge/      tsnet lifecycle (edge.go), certificates (cert.go),
                    the dry run (test.go), the reverse proxy (proxy.go),
                    the status store and state machine (state.go)
internal/control/   the loopback HTTP API
```
