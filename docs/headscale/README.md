# Running LocalCast on your own Headscale

**Persian translation: [README.fa.md](README.fa.md) — نسخهٔ فارسی**

This directory is a complete, deployable Headscale server for people who do not want
LocalCast's default path to depend on Tailscale's company-run coordination server.

Everything here is optional. LocalCast's default mode needs none of it.

Files in this directory:

| File | What it is |
|------|------------|
| `README.md` / `README.fa.md` | this walkthrough |
| `docker-compose.yml` | Headscale + Caddy, pinned versions, commented line by line |
| `config.yaml` | the Headscale server config, used as a template by `setup.sh` |
| `Caddyfile` | the reverse proxy that terminates TLS for the control plane |
| `setup.sh` | does sections 3 and 4 for you, and prints the two values LocalCast asks for |

---

## 1. What this is, and the one thing it cannot do

Headscale is an open-source re-implementation of Tailscale's **coordination server**. It is
the address book and key-exchange broker for a WireGuard mesh: it decides which devices are
in your network, hands them their `100.x` addresses, and tells them how to find each other.
It does not carry your data. Once two devices know about each other, the video bytes flow
directly between them over WireGuard, or through a relay if a direct path cannot be opened.

Running your own means the list of your devices lives on a machine you rent, not on
Tailscale's. That is the entire benefit, and for some people it is the whole point.

### Read this before you go any further

**Headscale cannot issue an HTTPS certificate for your LocalCast server.**

In LocalCast's default mode you never think about certificates. Tailscale's coordination
server implements an endpoint (`/machine/set-dns`) that lets a node ask the control plane to
publish an ACME DNS-01 challenge record on its behalf, so `tailscale cert` returns a real,
publicly-trusted Let's Encrypt certificate for `yourmachine.tailXXXX.ts.net` with zero setup.

Headscale has not implemented that endpoint. This is not a configuration you have missed and
not a version you need to upgrade to — as of the current stable release it does not exist.
Verified on 2026-09-01 against the upstream tracker:

- [juanfont/headscale#2527 — "tailscale cert + serve tracking"](https://github.com/juanfont/headscale/issues/2527)
  — **open**, opened 2025-04-14, last active 2026-08-31, milestone **v0.34**. The maintainer's
  own summary of the work: implement DNS record management for the base domain, add
  `/machine/set-dns`, support `DNSConfig.CertDomains`, and modernise certificate management.
  The most recent comment on it (2026-08-31) describes an *internal proof of concept* with
  Azure DNS support, not a merged feature.
- [juanfont/headscale#2137 — "\[Feature\] tailscale cert"](https://github.com/juanfont/headscale/issues/2137)
  — **open**, opened 2024-09-16, milestone **v0.34**.
- [juanfont/headscale#2696 — "Implement tailscale cert PoC"](https://github.com/juanfont/headscale/pull/2696)
  — **open, unmerged** pull request.
- The current stable release is **v0.29.3** (2026-07-29). Milestone v0.34 is four minor
  versions away and has no due date.

Tailscale **Funnel** — publishing a service to the public internet without a port forward —
is a service run by Tailscale, not a protocol feature, and is likewise unavailable:
[juanfont/headscale#1040](https://github.com/juanfont/headscale/issues/1040) is **closed as
not planned**. LocalCast enforces this: choosing "custom" mode and Funnel together is
rejected by the settings form, not discovered later.

**What this means in practice:** after you finish this guide you have a working private mesh,
but you must still choose *how* LocalCast gets its certificate. Section 5 gives you two
honest options. Neither is hard, but you cannot skip the choice, and LocalCast will not let
you save a configuration that cannot produce a certificate.

> If you are reading this months from now, check those issue links first. If Headscale has
> shipped `tailscale cert` support, section 5 is out of date and LocalCast's
> `certStrategy: 'control-plane'` restriction should be revisited.

---

## 2. What you need before you start

### A server

Headscale is a small Go binary with a SQLite database. It coordinates; it does not relay your
video. The load is tiny.

| | |
|---|---|
| CPU / RAM | 1 vCPU, 1 GB RAM is comfortable. 512 MB works. |
| Disk | 10 GB. The database for a household is measured in megabytes. |
| OS | Any current Linux with Docker. Debian 12/13 and Ubuntu 24.04 are the least surprising. |
| Network | A **static, public IPv4 address**. Not behind NAT. |

The cheapest tier at any VPS provider is enough. Do not pay for bandwidth you will not use —
unless you choose the `external-proxy` certificate strategy in section 5, in which case read
that section's warning about bandwidth *before* you pick a plan.

### A domain name

You need **two names**, and they must be different from each other:

| Purpose | Example | Notes |
|---|---|---|
| Control plane | `headscale.example.com` | Public. Points at the VPS. This becomes LocalCast's `controlUrl`. |
| MagicDNS base | `net.example.com` | Never resolves publicly. Becomes the suffix of every device name. |

Headscale refuses to start if these are the same domain, and the reason is real:
`headscale.example.com` must resolve on the public internet to your VPS, while
`*.net.example.com` must resolve to `100.x` tailnet addresses, and only for members of the
tailnet. One name cannot do both.

Your LocalCast server will end up as `localcast.net.example.com`.

Use a domain you genuinely control at the registrar, not a free subdomain from a dynamic-DNS
service. If you later choose the `dns01` certificate strategy you will need API access to
edit records under it.

### DNS records

One record, before you run anything:

```
headscale.example.com.   A      203.0.113.10      # your VPS's public IPv4
headscale.example.com.   AAAA   2001:db8::10      # optional, if your VPS has IPv6
```

Wait until it actually resolves before continuing:

```bash
dig +short headscale.example.com
```

If that prints nothing, Let's Encrypt will fail and you will spend an hour blaming Caddy.

**Do not create any DNS record for `net.example.com`.** MagicDNS lives inside the tailnet.

### Ports on the VPS

| Port | Protocol | Required | Why |
|---|---|---|---|
| 80 | TCP | **yes** | The ACME HTTP-01 challenge. Also the HTTP→HTTPS redirect. |
| 443 | TCP | **yes** | The control plane itself. |
| 443 | UDP | no | HTTP/3. Harmless to open, slightly faster if you do. |
| 22 | TCP | yes | Your SSH access. Do not lock yourself out. |
| 3478 | UDP | no | Only if you later enable the embedded DERP relay. This config does not. |

A common mistake: closing port 80 once the certificate is issued. Renewal happens roughly
every 60 days and uses the same challenge. It will fail silently, and about a month later
every device stops trusting your control plane at once.

### Tools

`docker` (Engine 20.10+ with the Compose v2 plugin), `jq`, and a text editor. The setup
script checks for all of them and names what is missing.

---

## 3. Deploying

Copy this directory to the VPS. Read the files. Then run the script — or do it by hand; the
script does nothing the manual steps do not.

```bash
scp -r docs/headscale/ you@203.0.113.10:~/headscale
ssh you@203.0.113.10
cd ~/headscale
less docker-compose.yml config.yaml Caddyfile setup.sh   # actually read them
```

There is deliberately no `curl … | bash` line anywhere in this project. A script that
provisions a network identity broker for your household is a script you read first.

### With the script

```bash
chmod +x setup.sh
./setup.sh
```

It asks for the control-plane domain, the MagicDNS base domain, an email address for
Let's Encrypt expiry notices, and a Headscale username. Then it writes the config, starts the
stack, creates the user, mints a pre-authentication key, and prints the two values you paste
into LocalCast.

Running it a second time is safe. It detects an existing `config/config.yaml` and offers to
reuse it, it will not create a duplicate user, and the only thing it always does is mint a
new key — because Headscale stores keys hashed and cannot show you an old one again.

It refuses to print the key if you redirect its output to a file. That is intentional: a
pre-authentication key registers a machine on your network and does not belong in a log.

### By hand

```bash
mkdir -p config lib caddy/data caddy/config

# 1. Render the config: change only these two live settings.
cp config.yaml config/config.yaml
$EDITOR config/config.yaml
#   server_url: https://headscale.example.com
#   dns.base_domain: net.example.com

# 2. Tell Caddy which domain to get a certificate for.
cat > .env <<'EOF'
HEADSCALE_DOMAIN=headscale.example.com
ACME_EMAIL=you@example.com
EOF

# 3. Up.
docker compose up -d
docker compose logs -f caddy      # watch the certificate arrive, then Ctrl-C
```

### About the pinned version

`docker-compose.yml` pins `docker.io/headscale/headscale:v0.29.3` and `caddy:2.11.4-alpine`.
Not `latest`, and not `stable`.

Headscale changes its CLI between minor releases in ways that break scripts. Two real
examples: in 0.26 the `--user` flag on `preauthkeys` stopped accepting a username and began
requiring a numeric ID; in 0.28 `preauthkeys expire` and `delete` moved from `--user <name>
<key>` to `--id <ID>`. An image tag that floats will apply one of those changes on a night
when you are not watching, and the failure will look like your own script is broken.

To upgrade later, read [the upstream upgrade guide](https://headscale.net/stable/setup/upgrade/),
back up `lib/` first, and move one stable minor version at a time.

The compose file also carries the v0.29.3 manifest digest in a comment if you want an
immutable pin instead of a tag.

---

## 4. The user, the key, and where the values go

Headscale groups devices under a **user**. For a household this is one user — the operator —
and every device belongs to it. A **pre-authentication key** lets a device register without a
browser login, which is exactly what LocalCast needs: `netedge` runs headless inside the
Electron process and has nobody to click a consent screen.

```bash
# Create the user (once).
docker compose exec headscale headscale users create home

# Find its numeric ID. Since 0.26 the next command needs the ID, not the name.
docker compose exec headscale headscale users list
# ID | Name | Username | Email | Created
# 1  |      | home     |       | 2026-09-01 ...
#
# The column you want is Username; "Name" is the optional display name and is
# blank unless you passed --display-name. Machine-readable form:
#   docker compose exec -T headscale headscale users list --output json | jq

# Mint a single-use key valid for 24 hours.
docker compose exec headscale headscale preauthkeys create --user 1 --expiration 24h
# hskey-auth-AbCdEfGhIjKl-<64 more characters>
```

If you pass the username instead of the ID you get
`Error: invalid argument "home" for "-u, --user" flag: strconv.ParseUint: parsing "home":
invalid syntax`. That is the changed flag, not a broken install.

> **The key is displayed once.** Headscale stores a bcrypt hash of it. `headscale preauthkeys
> list` will show `hskey-auth-AbCdEfGhIjKl-***` from then on — enough to identify the key, not
> enough to use it. If you lose the value before pasting it, mint another; there is no
> recovery and nothing is wrong.

Flags worth knowing:

| Flag | Effect |
|---|---|
| `--expiration 24h` | how long the key can still be *used to register*. Default `1h`. It has nothing to do with how long the device stays connected. |
| `--reusable` | lets several devices register with the same key. Convenient, and a single leaked string then admits any number of machines. Leave it off for LocalCast. |
| `--ephemeral` | the node is deleted when it disconnects. **Never** for a LocalCast server. |

### Into LocalCast

Open LocalCast on the Windows machine, go to **«تنظیمات» → «سرور هماهنگ‌کننده شبکه»**, and
switch from **«پیش‌فرض»** to **«سرور شخصی»**.

| Field on the page | Config key | What to enter | Example |
|---|---|---|---|
| «آدرس سرور» | `controlUrl` | Exactly your `server_url`. `https://`, no trailing slash, no path. | `https://headscale.example.com` |
| «کلید احراز هویت» | `authKey` | The `hskey-auth-…` string, whole. | `hskey-auth-AbCdEfGhIjKl-…` |
| «نام دستگاه» | `hostname` | The name this machine takes on the tailnet. | `localcast` |
| «روش گواهی» | `certStrategy` | `external-proxy` or `dns01` — **section 5**. | |
| «دامنهٔ گواهی» | `certDomain` | The name the certificate is for. Depends on the strategy. | |
| «انتشار» | `expose` | Must stay «فقط شبکهٔ خصوصی» (`tailnet`). Funnel does not exist here. | |

Two things the form will not let you do, and they are guard rails rather than limitations:

- **`certStrategy: control-plane` in custom mode** is rejected — *"Headscale cannot issue
  certificates through the control plane; choose external-proxy or dns01."* That is section 1.
- **`expose: funnel` in custom mode** is rejected — *"Funnel is a Tailscale service and is not
  available on a self-hosted control server."*

Press **«آزمایش اتصال»** before **«ذخیره»**. The test does a dry run: it checks the control
server is reachable *and* that the certificate strategy can actually produce a certificate. A
configuration that cannot work is refused while you are still looking at the form, instead of
becoming a permanent «در حال اتصال…» spinner.

The `authKey` is encrypted with Windows DPAPI before it touches disk and is never written to
a log.

---

## 5. TLS — and there are two different certificates

This is where most self-hosted setups go wrong, so be precise about which certificate is
being discussed.

**Certificate A — the control plane's.** For `https://headscale.example.com`. Caddy in
`docker-compose.yml` obtains and renews it automatically over HTTP-01. Nothing to decide.
Without it, Tailscale clients refuse to talk to the control server at all.

**Certificate B — LocalCast's.** For the name your iPhone types into its browser. In default
mode Tailscale hands this over for free. Headscale cannot (section 1). This is the one you
must choose a strategy for.

The rest of this section is only about certificate B.

### Option 1 — `external-proxy`: a reverse proxy in front of LocalCast

**Recommended if you want it working today.** A proxy you already control terminates TLS and
forwards plain HTTP to LocalCast over the tailnet. The most natural place for that proxy is
the VPS you have just built, which already has a public IP, an open port 443, and a Caddy that
knows how to get certificates.

1. Install Tailscale on the VPS and join it to your own Headscale. Prefer your
   distribution's package repository — [tailscale.com/download/linux](https://tailscale.com/download/linux)
   lists the apt/dnf steps. Tailscale also publishes a piped installer; it is theirs and it is
   signed, but it is still a script from the internet running as root, so read it first if you
   use it (`curl -fsSL https://tailscale.com/install.sh | less`).
   ```bash
   sudo tailscale up --login-server https://headscale.example.com --authkey hskey-auth-…
   ```
2. Add an A record: `localcast.example.com` → the VPS's public IP.
3. Uncomment the second site block at the bottom of `Caddyfile`, put LocalCast's `100.x`
   address in it, and `docker compose restart caddy`.
4. In LocalCast: `certStrategy` = `external-proxy`, `certDomain` = `localcast.example.com`.

**The trade-off, in one sentence:** every byte you stream now travels phone → VPS → WireGuard
→ home PC and back, so seeking around a 4K film is capped by your VPS's uplink and counts
against its bandwidth quota.

### Option 2 — `dns01`: LocalCast holds the certificate

**Recommended if you actually stream large video.** LocalCast runs its own ACME client and
proves it owns the domain by writing a TXT record through your DNS provider's API. Nothing
public ever has to reach the Windows machine, and the media path stays peer-to-peer over
WireGuard.

1. Pick a supported provider — LocalCast implements `cloudflare`, `digitalocean`, `route53`
   and `gandi` — and make sure `example.com` is hosted there.
2. Create an API token scoped as narrowly as the provider allows: edit DNS records for that
   one zone, nothing else.
3. In LocalCast: `certStrategy` = `dns01`, `certDomain` = `localcast.net.example.com` (your
   `hostname` plus your MagicDNS `base_domain`), `dnsProvider` and `dnsApiToken` as above.
4. LocalCast obtains the certificate, caches it, and renews it on its own. The token is stored
   encrypted with DPAPI, like the auth key.

**The trade-off, in one sentence:** you must hold an API token that can edit your DNS zone,
which is a real credential on a home machine — in exchange, the video path is direct and the
VPS carries nothing but coordination traffic.

### Choosing

| | `external-proxy` | `dns01` |
|---|---|---|
| Setup effort | low | medium |
| Extra credential | none | a DNS API token |
| Media path | through the VPS | direct, peer-to-peer |
| 4K seeking | limited by the VPS uplink | limited by your home upload |
| VPS bandwidth cost | proportional to what you watch | negligible |

Start with `external-proxy` to confirm the whole chain works, then move to `dns01` if
streaming feels slow. Switching between them is a settings change, not a reinstall.

---

## 6. Checking that it works

### The control plane is up

```bash
docker compose ps                       # both services 'running', headscale 'healthy'
curl -sS https://headscale.example.com/health
docker compose exec headscale headscale health
```

`docker compose logs caddy` should show a certificate obtained for your domain and then go
quiet. Repeated ACME attempts mean the challenge is failing — see section 8.

### The first client

Test with a laptop before you touch LocalCast, so that if something is wrong you know whether
to blame the mesh or the app.

```bash
sudo tailscale up --login-server https://headscale.example.com --authkey hskey-auth-…
tailscale status
tailscale ip -4          # expect something in 100.64.0.0/10
```

Your Tailscale client must be **v1.80.0 or newer** — that is the minimum this Headscale
release supports. Older clients are rejected outright.

### The node register

```bash
docker compose exec headscale headscale nodes list
```

Columns: `ID`, `Hostname`, `Name`, `MachineKey`, `NodeKey`, `User`, `Tags`, `IP addresses`,
`Ephemeral`, `Last seen`, `Expiration`, `Connected`, `Expired`.

A healthy row:

- `IP addresses` holds an address inside `100.64.0.0/10`
- `User` is your user (`home`)
- `Connected` is `true` while the device is online
- `Expired` is `false`
- `Last seen` is seconds ago, not hours
- `Ephemeral` is `false`

### LocalCast itself

After **«ذخیره»**, the tray dot goes «در حال اتصال…» → «متصل». `headscale nodes list` gains a
row named `localcast`. From the phone, `https://localcast.net.example.com` loads with no
certificate warning — no warning is the whole test; a padlock with a complaint behind it means
the certificate strategy is not doing what you think.

The two ends of the chain, in order: the tailnet gets you a route, the certificate gets you a
padlock. They fail independently and it is worth knowing which one broke.

---

## 7. Going back to the default coordination server

Open **«تنظیمات» → «سرور هماهنگ‌کننده شبکه»**, choose **«پیش‌فرض»**, test, save.

That is the whole procedure. LocalCast writes the new `network_config` row, restarts the tsnet
node inside the already-running `netedge` process, and does not touch anything else.

**What survives, because the SQLite database is not involved in the change:**

| | |
|---|---|
| Paired devices | kept — no device re-pairs, no QR codes are rescanned |
| The permission matrix | kept — every `(device, folder) → full/stream/none` row is untouched |
| Shared folders | kept, with their labels, writable flags and file index |
| Printers and print history | kept |
| WebDAV passwords | kept |
| Activity log | kept |

**What changes:** the server's hostname. In default mode it becomes something like
`localcast.tailXXXX.ts.net`; on your own Headscale it is `localcast.net.example.com`. Clients
handle this: the pairing record they stored is an identity, not an address, and they
re-resolve through it.

**What you should do anyway:**

- Certificate strategy resets to `control-plane` in default mode. That is correct — Tailscale
  issues it. Your `dnsApiToken`, if you had one, is no longer used.
- Every device needs the Tailscale app pointed at the *same* control server as LocalCast. A
  phone still logged into your Headscale cannot see a LocalCast that has moved to the default
  tailnet. Switching the phone back is `tailscale switch` on desktop, or logging out and back
  in in the iOS app.
- Leave the VPS running until you are sure. Coming back is the same three clicks in the other
  direction, and your Headscale still has the node registered.

If you are finished with Headscale for good, `docker compose down` stops it and
`docker compose down -v && rm -rf lib caddy` destroys it. `lib/` is the whole server —
`db.sqlite` plus `noise_private.key` — so copy it somewhere before you delete it if there is
any chance you will want it back.

---

## 8. When it does not work

### A node never appears in `headscale nodes list`

The client says `Success.` and then nothing shows up on the server.

- **The reverse proxy is eating the protocol upgrade.** The Tailscale control protocol
  upgrades an HTTP `POST` to a connection with the header
  `Upgrade: tailscale-control-protocol`. Caddy proxies arbitrary upgrades transparently, which
  is why the supplied `Caddyfile` needs no websocket directive — but nginx does not, and a
  hand-written nginx config missing `proxy_set_header Upgrade $http_upgrade;` produces exactly
  this symptom. If you replaced Caddy, this is your bug.
- **`server_url` and the URL the client used disagree.** They must match character for
  character, including scheme and the absence of a trailing slash. `https://hs.example.com`
  and `https://hs.example.com/` are different values here.
- **The key was already used.** A non-`--reusable` key registers one node, once.
  `headscale preauthkeys list` shows `Used: true`. Mint another.
- **The client is too old.** v0.29.3 requires Tailscale client v1.80.0 or newer.
- Watch it happen: `docker compose logs -f headscale` while the client connects.

### Certificate errors

Which certificate? Section 5 — get this right before you debug anything.

*The browser complains about `headscale.example.com`, or clients report a TLS failure against
the control plane:*

- `docker compose logs caddy`. Caddy says plainly what the ACME server told it.
- Port 80 must be reachable from the internet. Check from elsewhere, not from the VPS itself.
- The A record must point at this VPS. `dig +short headscale.example.com` from a machine that
  is not the VPS.
- If you have failed repeatedly, you may be rate-limited by Let's Encrypt for about a week.
  Uncomment `acme_ca … acme-staging-v02 …` in the `Caddyfile`, get the flow working against
  staging (whose certificates your browser will reject — that is expected), then comment it
  out again.

*The browser complains about `localcast.…`:* that is certificate B and this section does not
apply. Skip to "the wrong certificate strategy" below.

### Clock skew

WireGuard's handshake and TLS both reject timestamps that are too far out. A VPS whose clock
has drifted produces registrations that fail with signature or certificate-validity errors
that name neither problem.

```bash
timedatectl status          # want: "System clock synchronized: yes"
sudo timedatectl set-ntp true
```

Check the Windows machine too. It is usually the VPS after a suspend/restore, but not always.

### Key expiry

Two different expiries, and confusing them wastes an afternoon.

- **Pre-auth key expiry** (`--expiration`, default `1h`) — how long the key may still be used
  to *register* a new node. Once a node is registered, the key is irrelevant to it. An expired
  key only affects new registrations: `authkey expired`.
- **Node key expiry** — how long a registered node stays valid. The supplied `config.yaml` sets
  `node.expiry: 0`, meaning nodes never expire on their own, precisely so that LocalCast does
  not vanish from the network some quiet Tuesday. If you changed it, an expired node shows
  `Expired: true` in `headscale nodes list` and stops passing traffic while still being listed.
  Fix: `headscale nodes expire -i <ID> --disable` to switch expiry off for that node, or
  re-authenticate the client.

### The specific symptom of the wrong certificate strategy

This one is worth recognising on sight, because everything else looks healthy while it
happens: the node is connected, `headscale nodes list` is perfect, and the app is broken.

| What you see | What it means |
|---|---|
| LocalCast sits in «در حال دریافت گواهی» and never leaves it | `certStrategy` is `dns01` but the DNS API token is wrong, scoped too narrowly, or for the wrong zone. LocalCast will not fall back to a self-signed certificate — deliberately, because a self-signed certificate on iOS produces a broken WebDAV mount and an unexplainable video player rather than an error. |
| Safari: "This Connection Is Not Private" on `localcast.…` | You chose `external-proxy` but are connecting to LocalCast **directly** over the tailnet instead of through the proxy. Plain HTTP is being served on the tailnet address and that is what `external-proxy` means. Connect via `certDomain`, not via the `100.x` address or the MagicDNS name. |
| The page loads over HTTP but the PWA will not install, and the camera never opens for QR scanning | Same cause. Service workers and `getUserMedia` require a secure context. iOS will not budge on this. |
| `certDomain` does not match what the browser asked for | The certificate is valid but for another name. With `dns01`, `certDomain` must be `<hostname>.<base_domain>` — `localcast.net.example.com`. With `external-proxy` it must be the public name your proxy serves — `localcast.example.com`. Using the `dns01` name with `external-proxy`, or the reverse, gives a name-mismatch warning on a perfectly good certificate. |
| Saving is refused with "Headscale cannot issue certificates through the control plane" | You left the strategy at `control-plane` while switching to custom mode. That combination cannot work; see section 1. |

### Everything else

```bash
docker compose logs --tail 100 headscale
docker compose logs --tail 100 caddy
docker compose exec headscale headscale nodes list
docker compose exec headscale headscale preauthkeys list
```

Set `log.level: debug` in `config/config.yaml` and `docker compose restart headscale` while
chasing a registration problem. Headscale does not print pre-auth keys in full at any log
level. Put it back to `info` afterwards — debug is very noisy.

---

## Sources

Everything factual above was checked on **2026-09-01** against:

- [juanfont/headscale#2527 — tailscale cert + serve tracking](https://github.com/juanfont/headscale/issues/2527) (open, milestone v0.34)
- [juanfont/headscale#2137 — \[Feature\] tailscale cert](https://github.com/juanfont/headscale/issues/2137) (open, milestone v0.34)
- [juanfont/headscale#2696 — Implement tailscale cert PoC](https://github.com/juanfont/headscale/pull/2696) (open, unmerged)
- [juanfont/headscale#1040 — Plans to implement Funnel?](https://github.com/juanfont/headscale/issues/1040) (closed as not planned)
- [Headscale v0.29.3 release notes](https://github.com/juanfont/headscale/releases/tag/v0.29.3) (2026-07-29; minimum Tailscale client v1.80.0)
- [config-example.yaml at tag v0.29.3](https://github.com/juanfont/headscale/blob/v0.29.3/config-example.yaml) — every config key used here
- [Headscale container setup](https://headscale.net/stable/setup/install/container/) — image names, volume layout
- [Headscale reverse proxy reference](https://headscale.net/stable/ref/integration/reverse-proxy/) — required headers, the `tailscale-control-protocol` upgrade
- [Headscale TLS reference](https://headscale.net/stable/ref/tls/)
- [Headscale upgrade guide](https://headscale.net/stable/setup/upgrade/)
- CLI flags read from the source at tag v0.29.3: `cmd/headscale/cli/preauthkeys.go`, `users.go`, `nodes.go`
