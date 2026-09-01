module github.com/sadrazkh/localcast/netedge

go 1.23

// VERIFY: none of these versions could be resolved on the machine this file was written on —
// Go is not installed there, so `go mod tidy` never ran and no go.sum exists. They are the
// most plausible tags for each module, not verified ones. The first build step is therefore:
//
//	go get tailscale.com@latest github.com/caddyserver/certmagic@latest \
//	       github.com/libdns/cloudflare@latest github.com/libdns/digitalocean@latest \
//	       github.com/libdns/route53@latest github.com/libdns/gandi@latest
//	go mod tidy
//
// A wrong tag fails loudly with "unknown revision", which is the intended failure mode; no
// pseudo-versions are pinned here precisely because a fabricated commit hash would fail with
// a checksum mismatch instead, which looks like tampering rather than a stale pin.
require (
	github.com/caddyserver/certmagic v0.21.4
	github.com/libdns/cloudflare v0.1.3
	github.com/libdns/digitalocean v0.1.0
	github.com/libdns/gandi v1.0.3
	github.com/libdns/route53 v1.5.0
	tailscale.com v1.78.3
)
