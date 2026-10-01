#!/usr/bin/env bash
# provision-identity-hosts.sh <domain>
#
# Idempotently provisions nginx reverse-proxy + Let's Encrypt TLS for the two
# controller-side subdomains that every sender identity domain requires:
#
#   unsubscribe.<domain>  → proxies to controller (handles /u/:token endpoints)
#   click.<domain>        → proxies to controller (handles /c/:token and /o/:token.gif)
#
# IDEMPOTENCY CONTRACT
#   • Safe to run multiple times — each step is guarded with an existence check.
#   • If DNS is not yet propagated: the nginx HTTP block is still written and
#     enabled; certbot will fail with a clear error. Re-run the script once DNS
#     has propagated and certbot will complete without touching nginx again.
#   • If the cert already exists: certbot is skipped entirely.
#   • If the nginx config already exists (any state): it is never overwritten —
#     certbot may have already added its HTTPS block to it.
#
# PREREQUISITES
#   • Run as root or with sudo on the controller VPS.
#   • nginx and certbot must be installed:
#       apt-get install -y nginx certbot python3-certbot-nginx
#   • The DNS A records must point to this server BEFORE certbot can issue a cert
#     (the script prints the required records and warns if they are missing).
#
# USAGE
#   sudo bash scripts/provision-identity-hosts.sh <domain>
#   e.g.   sudo bash scripts/provision-identity-hosts.sh example.com
#
# ENVIRONMENT VARIABLES
#   CERTBOT_EMAIL   Email address registered with Let's Encrypt (required on first
#                   run per domain; stored by certbot, not needed on re-runs).
#                   Falls back to "admin@<domain>" with a warning if unset.

set -euo pipefail

# ── Argument validation ────────────────────────────────────────────────────────
DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "Usage: sudo bash $(basename "$0") <domain>" >&2
  echo "  e.g. sudo bash $(basename "$0") newdomain.org" >&2
  exit 1
fi
# Basic sanity check: must look like a domain (contains at least one dot, no spaces)
if [[ ! "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$ ]]; then
  echo "Error: '$DOMAIN' does not look like a valid domain name." >&2
  exit 1
fi

# ── Paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"
TEMPLATE="$SCRIPT_DIR/templates/nginx-identity-subdomain.conf"
NGINX_AVAILABLE="/etc/nginx/sites-available"
NGINX_ENABLED="/etc/nginx/sites-enabled"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "Error: nginx template not found at $TEMPLATE" >&2
  exit 1
fi

# ── Dependency checks ─────────────────────────────────────────────────────────
for cmd in nginx certbot; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: '$cmd' is not installed. Run:" >&2
    echo "  apt-get install -y nginx certbot python3-certbot-nginx" >&2
    exit 1
  fi
done

# ── Read BACKEND_PORT from backend/.env (fallback: 3001) ──────────────────────
BACKEND_PORT=3001
if [[ -f "$BACKEND_DIR/.env" ]]; then
  _port_line=$(grep -E '^PORT=' "$BACKEND_DIR/.env" 2>/dev/null || true)
  if [[ -n "$_port_line" ]]; then
    BACKEND_PORT="${_port_line#PORT=}"
    # Strip inline comments and whitespace
    BACKEND_PORT="${BACKEND_PORT%%#*}"
    BACKEND_PORT="${BACKEND_PORT//[[:space:]]/}"
  fi
fi

# ── Detect server public IP ───────────────────────────────────────────────────
SERVER_IP="UNKNOWN"
for _ip_svc in "https://ifconfig.me" "https://api.ipify.org" "https://checkip.amazonaws.com"; do
  _ip=$(curl -sf --max-time 5 "$_ip_svc" 2>/dev/null | tr -d '[:space:]' || true)
  if [[ "$_ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
    SERVER_IP="$_ip"
    break
  fi
done

# ── CERTBOT_EMAIL ─────────────────────────────────────────────────────────────
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
if [[ -z "$CERTBOT_EMAIL" ]]; then
  CERTBOT_EMAIL="admin@${DOMAIN}"
  echo "Note: CERTBOT_EMAIL not set — using '$CERTBOT_EMAIL' for Let's Encrypt registration."
  echo "      Set CERTBOT_EMAIL=you@example.com to use a specific address."
  echo
fi

echo "============================================================"
echo " Identity Host Provisioner"
echo " Domain  : $DOMAIN"
echo " Port    : $BACKEND_PORT"
echo " Server  : $SERVER_IP"
echo " Email   : $CERTBOT_EMAIL"
echo "============================================================"
echo

# ── Subdomains to provision ───────────────────────────────────────────────────
# Each entry: "subdomain_prefix:health_path"
SUBDOMAINS=("unsubscribe:/unsubscribe-health" "click:/tracking-health")

DNS_OK=true    # tracks whether all DNS records were verified
CERT_FAILED=false  # set true if certbot fails (DNS not propagated); script still exits 0
FINAL_RELOAD=0

for ENTRY in "${SUBDOMAINS[@]}"; do
  PREFIX="${ENTRY%%:*}"
  HEALTH_PATH="${ENTRY##*:}"
  SUBDOMAIN="${PREFIX}.${DOMAIN}"
  NGINX_CONF="$NGINX_AVAILABLE/${SUBDOMAIN}.conf"
  NGINX_LINK="$NGINX_ENABLED/${SUBDOMAIN}.conf"
  CERT_DIR="/etc/letsencrypt/live/${SUBDOMAIN}"

  echo "── $SUBDOMAIN ─────────────────────────────────────────────"

  # ── 1. DNS pre-check ────────────────────────────────────────────────────────
  RESOLVED_IP=""
  if command -v dig &>/dev/null; then
    RESOLVED_IP=$(dig +short A "$SUBDOMAIN" 2>/dev/null | grep -E '^[0-9]+\.' | head -1 || true)
  fi
  if [[ -z "$RESOLVED_IP" ]] && command -v host &>/dev/null; then
    RESOLVED_IP=$(host "$SUBDOMAIN" 2>/dev/null | awk '/has address/{print $4}' | head -1 || true)
  fi

  if [[ -z "$RESOLVED_IP" ]]; then
    echo "  [dns] ✗  $SUBDOMAIN does not resolve yet"
    DNS_OK=false
  elif [[ "$SERVER_IP" != "UNKNOWN" && "$RESOLVED_IP" != "$SERVER_IP" ]]; then
    echo "  [dns] ✗  $SUBDOMAIN → $RESOLVED_IP (expected $SERVER_IP)"
    DNS_OK=false
  else
    echo "  [dns] ✓  $SUBDOMAIN → $RESOLVED_IP"
  fi

  # ── 2. Nginx config ──────────────────────────────────────────────────────────
  if [[ -f "$NGINX_CONF" ]]; then
    echo "  [nginx] Config already exists — skipping write ($NGINX_CONF)"
  else
    echo "  [nginx] Writing HTTP config: $NGINX_CONF"
    sed \
      -e "s|__SUBDOMAIN__|${SUBDOMAIN}|g" \
      -e "s|__BACKEND_PORT__|${BACKEND_PORT}|g" \
      "$TEMPLATE" > "$NGINX_CONF"
    FINAL_RELOAD=1
  fi

  # ── 3. Nginx site symlink ────────────────────────────────────────────────────
  if [[ -L "$NGINX_LINK" ]]; then
    echo "  [nginx] Site already enabled"
  else
    echo "  [nginx] Enabling site: $NGINX_LINK"
    ln -s "$NGINX_CONF" "$NGINX_LINK"
    FINAL_RELOAD=1
  fi

  # ── 4. Reload nginx so it can serve the ACME HTTP challenge ─────────────────
  if [[ "$FINAL_RELOAD" -eq 1 ]]; then
    echo "  [nginx] Testing config..."
    nginx -t
    echo "  [nginx] Reloading nginx..."
    systemctl reload nginx
    FINAL_RELOAD=0
  fi

  # ── 5. Let's Encrypt certificate ─────────────────────────────────────────────
  if [[ -d "$CERT_DIR" ]]; then
    echo "  [cert]  Certificate already exists — skipping ($CERT_DIR)"
  else
    echo "  [cert]  Requesting Let's Encrypt certificate for $SUBDOMAIN..."
    if certbot --nginx \
      -d "$SUBDOMAIN" \
      --email "$CERTBOT_EMAIL" \
      --agree-tos \
      --redirect \
      --non-interactive; then
      echo "  [cert]  Certificate issued; nginx HTTPS block added by certbot"
      FINAL_RELOAD=1
    else
      echo "  [cert]  WARN: certbot failed for $SUBDOMAIN (DNS not propagated yet?)"
      echo "  [cert]  nginx HTTP config written; re-run once DNS resolves to complete TLS."
      CERT_FAILED=true
    fi
  fi

  echo
done

# ── Final nginx reload (picks up any certbot-modified configs) ────────────────
echo "── Final nginx reload ──────────────────────────────────────"
if nginx -t; then
  systemctl reload nginx
  echo "  [nginx] ✓ Reloaded"
else
  echo "  [nginx] WARN: nginx config test failed — skipping reload"
  ALL_HEALTHY=false
fi
echo

# ── Health probes ─────────────────────────────────────────────────────────────
echo "── Health probes ────────────────────────────────────────────"
ALL_HEALTHY=true
for ENTRY in "${SUBDOMAINS[@]}"; do
  PREFIX="${ENTRY%%:*}"
  HEALTH_PATH="${ENTRY##*:}"
  SUBDOMAIN="${PREFIX}.${DOMAIN}"
  URL="https://${SUBDOMAIN}${HEALTH_PATH}"
  printf "  %-55s" "$URL"
  if curl -sf --max-time 6 "$URL" > /dev/null 2>&1; then
    echo "✓"
  else
    echo "✗ (not yet reachable)"
    ALL_HEALTHY=false
  fi
done
echo

# ── Summary ───────────────────────────────────────────────────────────────────
echo "============================================================"
if $ALL_HEALTHY && ! $CERT_FAILED; then
  echo " ✓ All identity hosts for $DOMAIN are provisioned and healthy."
  echo
  echo " The controller readiness watchers will pick up the new"
  echo " hosts automatically within the next probe cycle (≤5 min)."
else
  echo " Provisioning complete — some hosts are not yet reachable."
  echo
  if ! $DNS_OK || $CERT_FAILED; then
    echo " ACTION REQUIRED — add these DNS records in your DNS provider"
    echo " (Cloudflare or registrar DNS), then re-run this script:"
    echo
    for ENTRY in "${SUBDOMAINS[@]}"; do
      PREFIX="${ENTRY%%:*}"
      SUBDOMAIN="${PREFIX}.${DOMAIN}"
      echo "   ${SUBDOMAIN}.  IN  A  ${SERVER_IP}"
    done
    echo
    echo " Once DNS propagates, re-run to complete certificate issuance:"
    echo "   sudo CERTBOT_EMAIL=${CERTBOT_EMAIL} bash $(realpath "$0") ${DOMAIN}"
  else
    echo " DNS records are in place. Possible causes:"
    echo "   • Let's Encrypt rate-limit hit — wait a few minutes and retry"
    echo "   • nginx or certbot error above — check output"
    echo "   • Controller backend is not running on port $BACKEND_PORT"
  fi
fi
echo "============================================================"
