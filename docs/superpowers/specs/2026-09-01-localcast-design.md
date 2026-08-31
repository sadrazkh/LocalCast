# LocalCast — Design Spec

Date: 2026-09-01
Status: approved (sections 1 and 2 approved by the owner; sections 3+ written under the
owner's instruction to proceed to completion without further approval gates)

LocalCast shares folders, streams video and prints remotely from a Windows machine to an
iPhone PWA and to other desktops, over a WireGuard mesh, with a real Let's Encrypt
certificate and no manual setup for the end user.

The visual reference is `LocalCast-standalone.html` (a 16-screen Persian design-doc canvas).
Its extracted design tokens live in [`docs/design-tokens.md`](../../design-tokens.md).

---

## 1. Product shape

Four surfaces, all speaking the same API:

| # | Surface | What it is |
|---|---------|------------|
| 1 | Windows server | Electron tray app; owns the files, the database and the network edge |
| 2 | Windows client | Electron app; browses and plays from a server, transfers files |
| 3 | Mobile PWA | React PWA installed to the iOS home screen; the primary client |
| 4 | Phone sharing | **Push model** — the PWA uploads to the server, which then hosts |

### 1.1 Surface 4 is deliberately not what the mockup drew

The mockup's screen 12 shows the phone hosting at `192.168.1.31:8420`. A PWA on iOS cannot
open a listening socket, cannot hold persistent access to the camera roll (no File System
Access API in Safari), and is suspended when the screen locks. Surface 4 is therefore a
resumable **upload** flow: the user picks photos/videos, they are pushed to a designated
writable folder on the Windows server, and every other device sees them through the one
normal path. The UI keeps the mockup's language ("اشتراک از گوشی") but never claims the
phone is a server.

---

## 2. Network and certificates

### 2.1 `netedge` — the Go sidecar

Electron spawns `netedge.exe` as an ordinary child process. **No UAC, no Windows service, no
TUN driver.** It embeds `tailscale.com/tsnet`, which is userspace WireGuard.

```
iPhone ──WireGuard/DERP──▶ netedge.exe (:443 on the tailnet, TLS terminated)
                                │  reverse proxy, injects X-LC-Edge-Secret + X-LC-Peer
                                ▼
                           Node server on 127.0.0.1:<ephemeral>
```

The Node server binds loopback only and rejects any request without the shared secret
header, so no other process on the machine can reach it by pointing a browser at localhost.

### 2.2 Three network modes

| Mode | Control plane | Certificate | Client needs |
|------|---------------|-------------|--------------|
| `default` (tailnet) | Tailscale | `LocalClient.CertPair` — control-plane ACME, zero input | Tailscale app on the phone |
| `default` + Funnel | Tailscale | same | nothing — public HTTPS URL |
| `custom` (Headscale) | user's Headscale | **not available from the control plane** | Tailscale app pointed at the same Headscale |

### 2.3 Headscale cannot issue certificates — this is designed for, not wished away

The original brief assumed `tailscale cert` works against Headscale. It does not.
Certificate issuance needs the control server to implement `/machine/set-dns` and write ACME
TXT records for the base domain; Headscale has not implemented it and the tracking issue has
no ETA ([headscale#2527](https://github.com/juanfont/headscale/issues/2527),
[headscale#2137](https://github.com/juanfont/headscale/issues/2137)). Funnel is likewise
unimplemented ([headscale#1040](https://github.com/juanfont/headscale/issues/1040)).

So `custom` mode offers two honest certificate strategies, chosen in the settings UI:

- **`external-proxy`** — the user already terminates TLS (Caddy/Traefik/nginx) in front of
  the node. LocalCast serves plain HTTP on the tailnet address and trusts the proxy.
- **`dns01`** — LocalCast runs its own ACME client (DNS-01) against a domain the user owns,
  using an API token for a supported DNS provider. Certificates are cached and auto-renewed.

The UI must state which strategy is in force and must never show "connecting…" when the real
state is "this mode cannot get a certificate without more input". A mode that cannot succeed
fails loudly at **test time**, before it is saved.

### 2.4 Switching modes never requires reinstalling

Changing mode writes `network_config`, restarts the tsnet node inside the running `netedge`
process, and leaves SQLite untouched. Devices, permissions and pairings survive. The only
user-visible consequence is that the server's hostname changes, which the clients handle by
re-resolving through the stored pairing record.

---

## 3. Data model

SQLite via `better-sqlite3`, WAL mode, one file under `%LOCALAPPDATA%\LocalCast\localcast.db`.
Migrations are numbered `.sql` files applied in order and recorded in `schema_migrations`.

| Table | Role |
|-------|------|
| `users` | owner of devices; one `owner` row seeded on first run |
| `devices` | paired device; `token_version` for instant revocation; `dav_password_hash` |
| `shared_folders` | absolute path, label, kind, auto-index flag, last index time |
| `folder_permissions` | `(device_id, folder_id) → full \| stream \| none` |
| `pairing_tokens` | 4-char code + hash of a 32-byte secret, 5-minute TTL, single use |
| `files` | index of path/size/mtime/kind for listing, counts and search (+ FTS5 on name) |
| `network_config` | single row: mode, control URL, encrypted auth key, expose, cert strategy |
| `printers` | Windows printer name, capabilities, status, operator's hide flag |
| `print_jobs` | queue and state machine, plus the real Windows spooler job id |
| `uploads` | resumable chunked upload sessions |
| `activity` | the mockup's "فعالیت" tab; capped and rolled |

Three rules that the implementation must not break:

1. **Secrets are never stored in plaintext.** The Headscale auth key and the JWT signing key
   go through Electron `safeStorage` (Windows DPAPI). `config.json` holds no secrets.
2. **`files` is an index, not the source of truth.** Every request that serves bytes
   re-resolves and re-`stat`s the path on disk. A stale index may show a file that is gone;
   it must never cause the wrong file to be served.
3. **Permissions are read from the database on every request**, not carried in the JWT. The
   token carries only `device_id` and `token_version`. Closing a device's access in the panel
   takes effect on the next request, not at token expiry.

### 3.1 The three access modes

| Mode | List | Range play | Full download | Print | Upload |
|------|:----:|:----------:|:-------------:|:-----:|:------:|
| `full` | ✓ | ✓ | ✓ | ✓ | ✓ (writable folders only) |
| `stream` | ✓ | ✓ | ✗ | ✗ | ✗ |
| `none` | ✗ | ✗ | ✗ | ✗ | ✗ |

**`stream` is a UI restriction, not a security boundary.** Anything that can request byte
ranges can reassemble the whole file. This is written down so nobody later mistakes it for
DRM. `none` is a real boundary: the folder is not listed, not searchable, and every path
under it 404s.

---

## 4. API contract

Everything is defined once in `packages/contract` as zod schemas, and both the server and
every client import it. Adding an Android client later means implementing two interfaces in
`packages/client-core`, not re-deriving the protocol.

### 4.1 Device API (over the tailnet, Bearer JWT)

| Route | Purpose |
|-------|---------|
| `POST /api/v1/pair/claim` | `{code, secret, deviceName, platform}` → pending device |
| `GET /api/v1/pair/status/:id` | poll until the operator approves → token + DAV password |
| `POST /api/v1/token/refresh` | rotating opaque refresh token |
| `GET /api/v1/me` | device identity and permission summary |
| `GET /api/v1/folders` | only folders whose mode is not `none` |
| `GET /api/v1/folders/:id/entries` | paged directory listing |
| `GET /api/v1/search?q=` | FTS5, restricted to permitted folders |
| `GET /api/v1/files/:id/meta` | metadata |
| `GET /api/v1/files/:id/content` | **the Range endpoint** |
| `GET /api/v1/printers` | printers the operator has not hidden |
| `POST /api/v1/print` | enqueue a job |
| `GET /api/v1/print/jobs`, `/:id` | job state |
| `POST /api/v1/uploads`, `PATCH /api/v1/uploads/:id` | resumable chunked upload |
| `GET /api/v1/events` | **SSE** — job status, device status, connection state |
| `/dav/<folderId>/...` | WebDAV, Basic auth, **read-only** |

SSE rather than WebSocket: the only traffic is server→client, SSE reconnects itself, and it
survives the tsnet and Funnel proxy paths with less ceremony.

WebDAV is read-only in every mode. A lost phone must not be able to delete the archive.
Writing happens only through the upload API, only into folders explicitly marked writable.

### 4.2 Operator API (loopback only, never on the tailnet)

Adding folders, approving devices, editing the permission matrix, minting pairing codes and
changing network settings are reachable only on `127.0.0.1` behind the edge secret. A stolen
device token cannot escalate, because the endpoints that could grant privilege are not
exposed to the network at all.

### 4.3 Pairing

QR payload: `{v:1, host, code, secret}` where `secret` is 32 random bytes, base64url. The
long secret makes the QR unguessable; the 4-character code is the manual fallback and is
locked after 5 failures.

**Rate limiting cannot be per-IP.** Behind Funnel every request arrives from Tailscale's
relays, so a per-IP bucket limits nothing. Three layers instead: a global bucket on
`pair/claim`, a per-code bucket with exponential backoff, and — in tailnet mode only — the
peer identity that `netedge` injects, which a client cannot forge.

---

## 5. Range streaming

This is where multi-gigabyte seeking either works or does not.

- `Accept-Ranges: bytes` on every media response; `GET` and `HEAD` only.
- `bytes=a-b`, `bytes=a-`, `bytes=-n` → `206` with a correct `Content-Range`.
- Unsatisfiable → `416` with `Content-Range: bytes */<size>`.
- Multiple ranges in one request → answer `200` with the full body. Safari never sends
  multi-range for video; `multipart/byteranges` is cost without benefit.
- `ETag: W/"<size>-<mtimeMs>"`. **Never hash the file** — hashing 18 GB per request is
  indefensible. `If-Range` is honoured against the ETag and `Last-Modified`.
- **Destroy the read stream on `res.close`.** Scrubbing a 4K file abandons dozens of
  in-flight requests; without this the process runs out of file descriptors. This is the
  single most common defect in hand-written video servers and it is explicitly tested.
- Paths use the `\\?\` long-path prefix, and after `fs.realpath` any path that resolves
  outside its shared root is rejected — junctions and symlinks included.
- No compression on media; `Content-Disposition: inline` for playback, `attachment` for
  downloads (and downloads are refused in `stream` mode).

---

## 6. Playback reality

Phase 1 ships **no ffmpeg**. That has consequences the UI must handle honestly:

- Safari plays MP4/H.264/AAC directly. It cannot open MKV containers and will not decode
  AC3/DTS audio. For those files the player shows "این فایل در مرورگر پخش نمی‌شود" and offers
  **"باز در پلیر بومی"**, a WebDAV URL that VLC and Infuse open natively.
- `hls.js` is included as a fallback for desktop browsers only. On iOS it needs
  ManagedMediaSource (17.1+) and native HLS covers the same ground anyway.
- **Video thumbnails need frame extraction and therefore ffmpeg.** Until phase 10 the
  library shows a generic media icon, not a poster frame. The mockup's thumbnails are
  aspirational and the spec says so rather than quietly shipping empty boxes.
- AirPlay uses the `x-webkit-airplay="allow"` attribute on the native `<video>` element.

---

## 7. Printing

- Enumeration: PowerShell `Get-Printer` → JSON, cached in `printers`, refreshed on demand.
- Submission: a bundled **SumatraPDF** binary (`-print-to`, `-print-settings`) handles PDF
  and images. No dependency on Office; office formats are out of scope and are rejected with
  a clear message rather than half-working.
- Status is read back from the real spooler via `Get-PrintJob` against the recorded
  `windows_job_id`, so "انجام‌شده" means the spooler said so, not that the process exited.
- States: `queued → printing → done | error | cancelled`.

---

## 8. Error handling and degradation

| Failure | Behaviour |
|---------|-----------|
| tsnet not yet authenticated | tray shows "ورود لازم است" with the login button; clients get 503 with a typed code |
| Certificate not yet issued | server holds requests, never falls back to self-signed |
| Headscale mode with no cert strategy | save is blocked at test time with the exact reason |
| Shared folder path gone (unplugged drive) | folder marked `unavailable`, listed greyed, files 404 with a typed code |
| Device revoked mid-stream | next range request 401s; the player surfaces "دسترسی بسته شد" |
| Print target offline | job goes to `error` with the spooler's message |
| Server unreachable from the PWA | red dot, offline library from IndexedDB, automatic retry with backoff |

Every error crosses the wire as `{error: {code, message}}` with a stable machine code from
`packages/contract`, so clients never string-match on prose.

---

## 9. Testing

Automated, runs on this machine:

- **Range correctness** — a deterministic pseudo-random 8 GB fixture generated into temp;
  ~200 random ranges plus the boundaries (`0`, `size-1`, `size`, `size+1`) compared
  byte-for-byte; and a leak test asserting handle count is flat after 500 aborted requests.
- **Path traversal** — table-driven over `..`, percent-encoded traversal, UNC prefixes,
  reserved names, `::$DATA` streams, and a junction pointing outside the root.
- **Permission matrix** — every `(mode × operation)` pair asserted, including that `none`
  folders are absent from listing and search.
- **Pairing** — expiry, single use, wrong secret, code lockout, and the rate-limit layers.
- **Network mode switch** — config change keeps the database and returns to connected.
- **Print state machine** — with the PowerShell and SumatraPDF calls faked at the boundary.

Not automatable here, so written as an acceptance checklist in
[`docs/acceptance-checklist.md`](../../acceptance-checklist.md):

- Seek on a real 4K file from cellular data.
- Print from a completely different network.
- Switch default ↔ personal Headscale and confirm no certificate error.
- iOS Files app and Infuse against the WebDAV mount.
- Home-screen install and camera permission for QR scanning.

Docker is not available on this machine, so the Headscale deployment in phase 9 is written
and reviewed but verified by the owner on a VPS.

---

## 10. Phases

| # | Phase | Depends on |
|---|-------|-----------|
| 1 | Spine: contract, schema, pairing/JWT, permissions, Range streaming | — |
| 2 | Network edge: `netedge`, three modes, cert strategies, test-before-save | 1 |
| 3 | Windows panel: wizard, tray, folders, device matrix, QR, settings | 1, 2 |
| 4 | PWA: manifest/SW, QR pairing, browser, player, offline, status | 1 |
| 5 | WebDAV | 1 |
| 6 | Printing | 1 |
| 7 | Phone upload (surface 4) | 1, 4 |
| 8 | Windows client | 1, 4 |
| 9 | Headscale docs, compose file, setup script | 2 |
| 10 | ffmpeg transcoding and poster frames | deferred by the owner |
