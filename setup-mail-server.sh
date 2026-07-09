#!/bin/bash
# =============================================================================
#  Mail Server Setup — edit the block below, then run:
#  sudo bash setup-mail-server.sh
# =============================================================================
set -euo pipefail

# ── YOUR CREDENTIALS ─────────────────────────────────────────────────────────
DOMAIN="serawin.net"
SERVER_IP="45.32.235.159"
FROM_NAME="Mail Campaign"
FROM_EMAIL="noreply@serawin.net"
APP_URL="https://serawin.net"
# ─────────────────────────────────────────────────────────────────────────────

MAIL_HOSTNAME="mail.$DOMAIN"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_ENV="$SCRIPT_DIR/.env"
DB_PATH="$SCRIPT_DIR/data/mail.db"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}==> $*${NC}"; }
success() { echo -e "${GREEN}✓  $*${NC}"; }
warn()    { echo -e "${YELLOW}!  $*${NC}"; }
error()   { echo -e "${RED}✗  $*${NC}"; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────────────────
[ "$EUID" -ne 0 ] && error "Run as root: sudo bash setup-mail-server.sh"
[ "$DOMAIN" = "yourdomain.com" ] && error "Edit DOMAIN at the top of this script before running."
[ "$SERVER_IP" = "1.2.3.4" ]    && error "Edit SERVER_IP at the top of this script before running."

info "Setting up mail server for $DOMAIN ($SERVER_IP)"

# ── 1. Install packages ───────────────────────────────────────────────────────
info "Installing Postfix and OpenDKIM..."
export DEBIAN_FRONTEND=noninteractive
debconf-set-selections <<< "postfix postfix/mailname string $DOMAIN"
debconf-set-selections <<< "postfix postfix/main_mailer_type string 'Internet Site'"
apt-get update -q
apt-get install -y postfix opendkim opendkim-tools mailutils sqlite3
success "Packages installed"

# ── 2. Configure Postfix ──────────────────────────────────────────────────────
info "Configuring Postfix..."
postconf -e "myhostname = $MAIL_HOSTNAME"
postconf -e "mydomain = $DOMAIN"
postconf -e "myorigin = \$mydomain"
postconf -e "inet_interfaces = loopback-only"
postconf -e "mydestination = \$myhostname, localhost.\$mydomain, localhost"
postconf -e "mynetworks = 127.0.0.0/8 [::ffff:127.0.0.0]/104 [::1]/128"
postconf -e "relayhost ="
postconf -e "milter_protocol = 2"
postconf -e "milter_default_action = accept"
postconf -e "smtpd_milters = inet:localhost:8891"
postconf -e "non_smtpd_milters = inet:localhost:8891"
success "Postfix configured"

# ── 3. Configure OpenDKIM ─────────────────────────────────────────────────────
info "Configuring OpenDKIM..."
mkdir -p /etc/opendkim/keys/$DOMAIN

cat > /etc/opendkim.conf <<EOF
Syslog              yes
SyslogSuccess       yes
LogWhy              yes
Canonicalization    relaxed/simple
ExternalIgnoreList  relist:/etc/opendkim/TrustedHosts
InternalHosts       relist:/etc/opendkim/TrustedHosts
KeyTable            refile:/etc/opendkim/KeyTable
SigningTable        refile:/etc/opendkim/SigningTable
Mode                sv
PidFile             /var/run/opendkim/opendkim.pid
SignatureAlgorithm  rsa-sha256
UserID              opendkim:opendkim
Socket              inet:8891@localhost
EOF

cat > /etc/opendkim/TrustedHosts <<EOF
127.0.0.1
localhost
$DOMAIN
EOF

cat > /etc/opendkim/KeyTable <<EOF
mail._domainkey.$DOMAIN $DOMAIN:mail:/etc/opendkim/keys/$DOMAIN/mail.private
EOF

cat > /etc/opendkim/SigningTable <<EOF
*@$DOMAIN mail._domainkey.$DOMAIN
EOF

# ── 4. Generate DKIM key (skip if already exists) ────────────────────────────
if [ ! -f "/etc/opendkim/keys/$DOMAIN/mail.private" ]; then
  info "Generating DKIM key pair..."
  opendkim-genkey -s mail -d "$DOMAIN" -D "/etc/opendkim/keys/$DOMAIN/"
  success "DKIM key generated"
else
  warn "DKIM key already exists — skipping generation"
fi

chown -R opendkim:opendkim /etc/opendkim/keys/
chmod 600 "/etc/opendkim/keys/$DOMAIN/mail.private"

# ── 5. Start / restart services ───────────────────────────────────────────────
info "Starting services..."
systemctl enable opendkim postfix
systemctl restart opendkim
sleep 1
systemctl restart postfix
success "Postfix and OpenDKIM running"

# ── 6. Update backend/.env ───────────────────────────────────────────────────
info "Updating backend/.env..."
if [ -f "$BACKEND_ENV" ]; then
  if grep -q "^APP_URL=" "$BACKEND_ENV"; then
    sed -i "s|^APP_URL=.*|APP_URL=$APP_URL|" "$BACKEND_ENV"
  else
    echo "APP_URL=$APP_URL" >> "$BACKEND_ENV"
  fi
  success "APP_URL updated in .env"
else
  warn "backend/.env not found at $BACKEND_ENV — skipping"
fi

# ── 7. Update SMTP config in the database ────────────────────────────────────
info "Updating SMTP config in database..."
if [ -f "$DB_PATH" ]; then
  sqlite3 "$DB_PATH" \
    "UPDATE smtp_config SET host='localhost', port=25, secure=0, user='', pass='', fromName='$FROM_NAME', fromAddr='$FROM_EMAIL' WHERE id=1;"
  success "Database SMTP config updated"
else
  warn "Database not found at $DB_PATH — start the app once first, then re-run this script"
fi

# ── 8. Extract DKIM DNS record value ─────────────────────────────────────────
DKIM_RAW=$(cat "/etc/opendkim/keys/$DOMAIN/mail.txt")
DKIM_VALUE=$(echo "$DKIM_RAW" | grep -oP '"[^"]+"' | tr -d '"' | tr -d '\n')

# ── 9. Print DNS records ──────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  SETUP COMPLETE — Add these DNS records in Cloudflare:${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${CYAN}Type   Name               Value                                Proxy${NC}"
echo "----------------------------------------------------------------------"
echo "MX     @                  $MAIL_HOSTNAME  (Priority: 10)   DNS only"
echo "A      mail               $SERVER_IP                        DNS only ⚠"
echo "TXT    @                  v=spf1 ip4:$SERVER_IP ~all        DNS only"
echo "TXT    _dmarc             v=DMARC1; p=none; rua=mailto:postmaster@$DOMAIN  DNS only"
echo ""
echo "TXT    mail._domainkey    (see below — paste the full value)  DNS only"
echo ""
echo -e "${YELLOW}DKIM TXT record value:${NC}"
echo "$DKIM_VALUE"
echo ""
echo "--------------------------------------------------------------"
echo -e "${YELLOW}⚠  Cloudflare note:${NC} The 'mail' A record MUST be set to 'DNS only'"
echo "   (grey cloud icon). If it is proxied (orange cloud), email delivery breaks."
echo ""
echo -e "${CYAN}Vultr Reverse DNS:${NC} Go to Vultr dashboard → your server"
echo "  Settings → Reverse DNS → set to: $MAIL_HOSTNAME"
echo ""
echo -e "${CYAN}Vultr port 25:${NC} Open a support ticket if not unblocked yet:"
echo "  \"Please unblock outbound port 25 for IP $SERVER_IP\""
echo ""
echo -e "${GREEN}App SMTP settings have been saved to the database:${NC}"
echo "  Host: localhost  |  Port: 25  |  Secure: off  |  No auth"
echo "  From: $FROM_NAME <$FROM_EMAIL>"
echo ""
echo -e "${YELLOW}Restart your Node.js app:${NC}  pm2 restart backend"
echo ""

# ── 10. Quick local smoke test ────────────────────────────────────────────────
info "Running quick local send test..."
if echo "Test from $DOMAIN mail server" | mail -s "Mail server setup test" "root@localhost" 2>/dev/null; then
  success "Local mail delivery working"
else
  warn "Local test failed — check: systemctl status postfix"
fi
