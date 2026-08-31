#!/usr/bin/env bash
#
# setup.sh — bring up Headscale + Caddy for LocalCast, and print the two values
#            you paste into LocalCast's network settings page.
#
# Read this script before you run it. It is meant to be read: it is a
# transcript of the manual steps in README.md, not a black box.
#
# There is deliberately no `curl ... | bash` one-liner anywhere in this project.
# Copy the docs/headscale/ directory to your VPS, read it, then run it.
#
# Usage:
#   ./setup.sh
#   HEADSCALE_DOMAIN=headscale.example.com \
#   BASE_DOMAIN=net.example.com \
#   ACME_EMAIL=you@example.com \
#   HEADSCALE_USER=home ./setup.sh      # non-interactive
#
# Running it twice is safe. It will not overwrite an existing config without
# asking, it will not create a second user with the same name, and the only
# thing it does unconditionally is mint a fresh pre-auth key — because Headscale
# stores keys hashed and an old key's text cannot be shown again.

set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Where are we
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colours only when a human is looking.
if [ -t 1 ]; then
	B=$'\033[1m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; N=$'\033[0m'
else
	B=''; R=''; G=''; Y=''; N=''
fi

info()  { printf '%s\n' "$*"; }
ok()    { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
warn()  { printf '%s!%s %s\n' "$Y" "$N" "$*" >&2; }
die()   { printf '%s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }
head1() { printf '\n%s== %s ==%s\n' "$B" "$*" "$N"; }

case "${1:-}" in
	-h|--help)
		# Lines 3..22 are the header comment above `set -euo pipefail`.
		sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	'') ;;
	*) die "unknown argument: $1 (try --help)" ;;
esac

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------

head1 "1/6  Checking prerequisites"

need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1 — $2"; }

need docker "install Docker Engine: https://docs.docker.com/engine/install/"
need jq     "install it with your package manager (apt install jq / dnf install jq)"

# Compose v2 is a docker subcommand. The old standalone docker-compose v1 is
# end-of-life and does not support the `depends_on: condition:` form used in
# docker-compose.yml, so refuse it rather than fail obscurely later.
if ! docker compose version >/dev/null 2>&1; then
	die "Docker Compose v2 not found. \`docker compose version\` must work. The
     standalone \`docker-compose\` (v1) binary is not supported."
fi

docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon. Start it, or add
     yourself to the 'docker' group and log in again."

for f in docker-compose.yml Caddyfile config.yaml; do
	[ -f "$f" ] || die "$f is missing from $SCRIPT_DIR — copy the whole docs/headscale/ directory"
done

ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'), compose v2, jq"

# ---------------------------------------------------------------------------
# 2. Ask for the domains and the email
# ---------------------------------------------------------------------------

head1 "2/6  Configuration"

CONFIG_FILE="config/config.yaml"
REUSE_CONFIG=no

if [ -f "$CONFIG_FILE" ]; then
	info "An existing configuration was found at $CONFIG_FILE:"
	info "    server_url:  $(awk '/^server_url:/{print $2; exit}' "$CONFIG_FILE")"
	info "    base_domain: $(awk '/^[[:space:]]+base_domain:/{print $2; exit}' "$CONFIG_FILE")"
	info ""
	if [ -t 0 ]; then
		read -r -p "Reuse it? [Y/n] " ans
	else
		ans=y
		info "(stdin is not a terminal — reusing it)"
	fi
	case "${ans:-y}" in
		[Nn]*)
			backup="$CONFIG_FILE.bak.$(date +%Y%m%d-%H%M%S)"
			cp -p "$CONFIG_FILE" "$backup"
			ok "old config saved as $backup"
			;;
		*)
			REUSE_CONFIG=yes
			ok "reusing the existing config — the container will not be reconfigured"
			;;
	esac
fi

ask() { # ask VARNAME "prompt" "default"
	local __var="$1" __prompt="$2" __default="${3:-}" __ans=""
	# An environment variable of the same name wins, so the script can run
	# unattended in a provisioning tool.
	if [ -n "${!__var:-}" ]; then
		printf '%s: %s (from environment)\n' "$__prompt" "${!__var}"
		return 0
	fi
	if [ ! -t 0 ]; then
		die "$__var is not set and stdin is not a terminal. Set it in the environment
     or run this script interactively."
	fi
	if [ -n "$__default" ]; then
		read -r -p "$__prompt [$__default]: " __ans
		__ans="${__ans:-$__default}"
	else
		while [ -z "$__ans" ]; do read -r -p "$__prompt: " __ans; done
	fi
	printf -v "$__var" '%s' "$__ans"
}

is_hostname() { [[ "$1" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$ ]]; }

if [ "$REUSE_CONFIG" = yes ]; then
	HEADSCALE_DOMAIN="$(awk '/^server_url:/{print $2; exit}' "$CONFIG_FILE" | sed 's#^https\?://##; s#/$##')"
	BASE_DOMAIN="$(awk '/^[[:space:]]+base_domain:/{print $2; exit}' "$CONFIG_FILE")"
	# .env may predate this run; only ask for the email if it is not there.
	if [ -f .env ]; then
		ACME_EMAIL="${ACME_EMAIL:-$(awk -F= '/^ACME_EMAIL=/{print $2; exit}' .env)}"
	fi
	[ -n "${ACME_EMAIL:-}" ] || ask ACME_EMAIL "Email for Let's Encrypt expiry notices"
else
	info "The control-plane domain is what Tailscale clients connect to, and what"
	info "you paste into LocalCast as controlUrl. Its A record must already point"
	info "at this VPS."
	ask HEADSCALE_DOMAIN "Control-plane domain" "headscale.example.com"

	info ""
	info "The MagicDNS base domain becomes the suffix of every device name"
	info "(localcast.<base>). It MUST be a different domain from the one above,"
	info "and you must own it — the dns01 certificate strategy proves ownership"
	info "of it to Let's Encrypt later."
	ask BASE_DOMAIN "MagicDNS base domain" "net.example.com"

	info ""
	ask ACME_EMAIL "Email for Let's Encrypt expiry notices"
fi

ask HEADSCALE_USER "Headscale username to own the LocalCast node" "${HEADSCALE_USER:-home}"

# --- validate ---------------------------------------------------------------

is_hostname "$HEADSCALE_DOMAIN" || die "'$HEADSCALE_DOMAIN' does not look like a domain name"
is_hostname "$BASE_DOMAIN"      || die "'$BASE_DOMAIN' does not look like a domain name"
[[ "$ACME_EMAIL" == *@*.* ]]    || die "'$ACME_EMAIL' does not look like an email address"
[[ "$HEADSCALE_USER" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || die "username must be lowercase letters, digits, '.', '_' or '-'"

if [ "$HEADSCALE_DOMAIN" = "$BASE_DOMAIN" ]; then
	die "the control-plane domain and the MagicDNS base domain must differ.
     Headscale refuses to start otherwise, and for a good reason:
     $HEADSCALE_DOMAIN must resolve publicly to this VPS, while
     *.$BASE_DOMAIN must resolve to 100.x tailnet addresses."
fi

case "$HEADSCALE_DOMAIN" in
	*".$BASE_DOMAIN")
		die "$HEADSCALE_DOMAIN sits inside $BASE_DOMAIN. MagicDNS would then own the
     control-plane name and clients could lose their way back to it. Pick a
     base domain that does not contain the control-plane name." ;;
esac

if [[ "$HEADSCALE_DOMAIN" == *example.com || "$BASE_DOMAIN" == *example.com ]]; then
	warn "example.com is a reserved documentation domain. Let's Encrypt will refuse
     to issue a certificate for it. Re-run with domains you actually own."
fi

# --- soft pre-flight checks -------------------------------------------------

if command -v getent >/dev/null 2>&1; then
	resolved="$(getent ahostsv4 "$HEADSCALE_DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
	if [ -z "$resolved" ]; then
		warn "$HEADSCALE_DOMAIN does not resolve yet. Caddy's certificate request will
     fail until the A record exists and has propagated. Continuing anyway."
	else
		info "    $HEADSCALE_DOMAIN resolves to $resolved"
		info "    (it must be THIS server's public address, or ACME will fail)"
	fi
fi

if command -v ss >/dev/null 2>&1; then
	for p in 80 443; do
		if ss -ltnH "sport = :$p" 2>/dev/null | grep -q .; then
			warn "something is already listening on port $p. Caddy will not be able to
     bind it. Stop the other service (often nginx or apache) first."
		fi
	done
fi

# ---------------------------------------------------------------------------
# 3. Write the files
# ---------------------------------------------------------------------------

head1 "3/6  Writing configuration"

mkdir -p config lib caddy/data caddy/config

if [ "$REUSE_CONFIG" = yes ]; then
	ok "config/config.yaml kept as-is"
else
	# Render the template by replacing only the two live settings. The example
	# domains that appear in the COMMENTS are left alone on purpose — they are
	# explanations, and rewriting them would produce sentences that no longer
	# make sense.
	tmp="$(mktemp)"
	trap 'rm -f "$tmp"' EXIT
	sed \
		-e "s|^server_url: .*|server_url: https://${HEADSCALE_DOMAIN}|" \
		-e "s|^\([[:space:]]*\)base_domain: .*|\1base_domain: ${BASE_DOMAIN}|" \
		config.yaml >"$tmp"

	# Fail loudly rather than starting a server on the wrong domain.
	grep -q "^server_url: https://${HEADSCALE_DOMAIN}$" "$tmp" \
		|| die "template substitution failed for server_url — is config.yaml intact?"
	grep -q "base_domain: ${BASE_DOMAIN}$" "$tmp" \
		|| die "template substitution failed for base_domain — is config.yaml intact?"

	mv "$tmp" "$CONFIG_FILE"
	trap - EXIT
	ok "config/config.yaml written"
fi

# .env feeds the Caddyfile. It holds no secrets — the pre-auth key is never
# written to disk by this script.
umask 077
cat >.env <<EOF
# Written by setup.sh on $(date -u '+%Y-%m-%dT%H:%M:%SZ'). Read by docker-compose.yml
# and substituted into the Caddyfile. Contains no secrets.
HEADSCALE_DOMAIN=${HEADSCALE_DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
EOF
umask 022
ok ".env written"

# ---------------------------------------------------------------------------
# 4. Start the stack
# ---------------------------------------------------------------------------

head1 "4/6  Starting Headscale and Caddy"

dc() { docker compose "$@"; }

dc pull --quiet 2>/dev/null || dc pull
dc up -d

info "Waiting for Headscale to answer its health check..."
healthy=no
for _ in $(seq 1 60); do
	if dc exec -T headscale headscale health >/dev/null 2>&1; then
		healthy=yes
		break
	fi
	sleep 2
done

if [ "$healthy" != yes ]; then
	warn "Headscale did not become healthy within 120 seconds. Recent logs:"
	dc logs --tail 40 headscale >&2 || true
	die "aborting before creating a user. Fix the errors above and re-run this script."
fi
ok "Headscale is healthy"

# ---------------------------------------------------------------------------
# 5. User and pre-auth key
# ---------------------------------------------------------------------------

head1 "5/6  User and pre-authentication key"

# `-T` matters: without it Compose allocates a pseudo-terminal and the JSON
# comes back with carriage returns that jq chokes on.
hs() { dc exec -T headscale headscale "$@"; }

# An empty user list serialises as `null`, not `[]`, so normalise it.
user_id="$(hs users list --output json | jq -r --arg n "$HEADSCALE_USER" \
	'(. // []) | map(select(.name == $n)) | (.[0].id // empty)')"

if [ -z "$user_id" ]; then
	hs users create "$HEADSCALE_USER" >/dev/null
	user_id="$(hs users list --output json | jq -r --arg n "$HEADSCALE_USER" \
		'(. // []) | map(select(.name == $n)) | (.[0].id // empty)')"
	[ -n "$user_id" ] || die "created user '$HEADSCALE_USER' but could not read its ID back"
	ok "created user '$HEADSCALE_USER' (id $user_id)"
else
	ok "user '$HEADSCALE_USER' already exists (id $user_id)"
fi

# From Headscale 0.26 onwards --user takes the NUMERIC ID, not the name. Passing
# a name fails with a strconv.ParseUint error that reads like a bug in the
# script rather than a changed flag, which is why we looked the ID up above.
#
# 24h is the window in which you must connect LocalCast. The key is single-use:
# once the node registers, the key is spent. It is not a long-lived credential.
KEY_EXPIRY="${KEY_EXPIRY:-24h}"

if [ ! -t 1 ]; then
	warn "stdout is redirected, so the pre-authentication key will NOT be printed."
	warn "A pre-auth key is a credential that registers a machine on your tailnet;"
	warn "it does not belong in a log file. Everything above is already done —"
	warn "re-run this script on a terminal to mint and read the key."
	exit 1
fi

auth_key="$(hs preauthkeys create --user "$user_id" --expiration "$KEY_EXPIRY" | tr -d '\r' | tr -d '[:space:]')"

case "$auth_key" in
	hskey-auth-*) ;;
	*) die "unexpected output from 'headscale preauthkeys create'. Expected a key
     starting with 'hskey-auth-'. Check: docker compose logs headscale" ;;
esac

ok "minted a single-use pre-auth key, valid for $KEY_EXPIRY"

# ---------------------------------------------------------------------------
# 6. The two values LocalCast asks for
# ---------------------------------------------------------------------------

head1 "6/6  Paste these into LocalCast"

cat <<EOF

  LocalCast → «تنظیمات» → «سرور هماهنگ‌کننده شبکه» → «سرور شخصی»

  ${B}controlUrl${N}   («آدرس سرور»)
      https://${HEADSCALE_DOMAIN}

  ${B}authKey${N}      («کلید احراز هویت»)
      ${auth_key}

  Then choose a certificate strategy. Headscale cannot issue one for you —
  see README.md section 5 before you pick:

    external-proxy   a reverse proxy in front of LocalCast holds the
                     certificate. Simplest. All media traffic goes through it.
    dns01            LocalCast holds the certificate, proven over DNS.
                     More setup. Media stays peer-to-peer.

  Expected MagicDNS name once connected:  localcast.${BASE_DOMAIN}

EOF

warn "The key above is shown ONCE. Headscale stores only a bcrypt hash of it, so
     \`headscale preauthkeys list\` will show 'hskey-auth-<prefix>-***' and never
     the full value again. If you lose it, re-run this script to mint another."

info ""
info "Verify from here:"
info "    docker compose exec headscale headscale nodes list"
info "    docker compose logs -f caddy      # watch the certificate being issued"
info "    curl -sS https://${HEADSCALE_DOMAIN}/health"
info ""
