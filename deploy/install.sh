#!/usr/bin/env bash
# Installation de Naoned sur Ubuntu 22.04 / 24.04 (root requis). Debian 12 ne fournit plus le paquet asterisk.
# Usage : sudo ./deploy/install.sh mon-domaine.fr
set -euo pipefail

DOMAIN="${1:-}"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR=/opt/naoned

if [[ $EUID -ne 0 ]]; then echo "Lancez ce script en root (sudo)."; exit 1; fi
if [[ -z "$DOMAIN" ]]; then echo "Usage : sudo $0 mon-domaine.fr"; exit 1; fi
if [[ ! -f "$SRC_DIR/.env" ]]; then
  echo "Créez d'abord $SRC_DIR/.env à partir de .env.example puis relancez."; exit 1
fi

set -a; source "$SRC_DIR/.env"; set +a
for v in ADMIN_PASSWORD OPENAI_API_KEY SIP_PROVIDER_HOST SIP_USERNAME SIP_PASSWORD; do
  if [[ -z "${!v:-}" ]]; then echo "Variable $v vide dans .env"; exit 1; fi
done

gen() { openssl rand -hex 16; }
PUBLIC_IP="${PUBLIC_IP:-$(curl -fsS https://api.ipify.org || true)}"
[[ -z "$PUBLIC_IP" ]] && { echo "Impossible de détecter l'IP publique : renseignez PUBLIC_IP dans .env"; exit 1; }
ARI_USER="${ARI_USER:-naoned}"
ARI_APP="${ARI_APP:-naoned}"
PORT="${PORT:-3000}"

# Génère les secrets manquants et les écrit dans .env
ensure_env() {
  local key=$1 val=$2
  if grep -qE "^${key}=.+" "$SRC_DIR/.env"; then return; fi
  if grep -qE "^${key}=" "$SRC_DIR/.env"; then sed -i "s|^${key}=.*|${key}=${val}|" "$SRC_DIR/.env"
  else echo "${key}=${val}" >> "$SRC_DIR/.env"; fi
  export "$key=$val"
}
ensure_env ARI_PASSWORD "$(gen)"
ensure_env SESSION_SECRET "$(openssl rand -hex 32)"
ensure_env TEST_PHONE_PASSWORD "$(gen)"
ensure_env PUBLIC_IP "$PUBLIC_IP"
set -a; source "$SRC_DIR/.env"; set +a

echo "==> Paquets système"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg nginx certbot python3-certbot-nginx ufw fail2ban asterisk

if ! command -v node >/dev/null || [[ $(node -p 'process.versions.node.split(".")[0]') -lt 22 ]]; then
  echo "==> Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Configuration Asterisk"
BACKUP=/etc/asterisk/backup-$(date +%Y%m%d%H%M%S)
mkdir -p "$BACKUP"
render() {
  sed -e "s|{{ARI_USER}}|${ARI_USER}|g" -e "s|{{ARI_PASSWORD}}|${ARI_PASSWORD}|g" -e "s|{{ARI_APP}}|${ARI_APP}|g" \
      -e "s|{{PUBLIC_IP}}|${PUBLIC_IP}|g" -e "s|{{SIP_PROVIDER_HOST}}|${SIP_PROVIDER_HOST}|g" \
      -e "s|{{SIP_USERNAME}}|${SIP_USERNAME}|g" -e "s|{{SIP_PASSWORD}}|${SIP_PASSWORD}|g" \
      -e "s|{{TEST_PHONE_PASSWORD}}|${TEST_PHONE_PASSWORD}|g" -e "s|{{DOMAIN}}|${DOMAIN}|g" -e "s|{{PORT}}|${PORT}|g" "$1"
}
for f in http.conf ari.conf rtp.conf pjsip.conf extensions.conf; do
  [[ -f /etc/asterisk/$f ]] && cp "/etc/asterisk/$f" "$BACKUP/"
  render "$SRC_DIR/asterisk/$f" > "/etc/asterisk/$f"
done
# Désactive l'ancien chan_sip s'il existe (conflit sur le port 5060)
grep -q '^noload => chan_sip.so' /etc/asterisk/modules.conf 2>/dev/null || echo 'noload => chan_sip.so' >> /etc/asterisk/modules.conf
chown -R asterisk:asterisk /etc/asterisk
chmod 640 /etc/asterisk/{ari,pjsip}.conf
mkdir -p /var/spool/asterisk/recording
chown asterisk:asterisk /var/spool/asterisk/recording
chmod 2770 /var/spool/asterisk/recording
systemctl enable asterisk
systemctl restart asterisk

echo "==> Application"
id naoned >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin naoned
usermod -aG asterisk naoned
mkdir -p "$APP_DIR"
cp -r "$SRC_DIR"/{package.json,src,public} "$APP_DIR"/
[[ -f "$SRC_DIR/package-lock.json" ]] && cp "$SRC_DIR/package-lock.json" "$APP_DIR"/
cp "$SRC_DIR/.env" "$APP_DIR/.env"
sed -i "s|^COOKIE_SECURE=.*|COOKIE_SECURE=true|" "$APP_DIR/.env"
mkdir -p "$APP_DIR/data"
(cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund)
chown -R naoned:naoned "$APP_DIR"
chmod 600 "$APP_DIR/.env"
cp "$SRC_DIR/deploy/naoned.service" /etc/systemd/system/naoned.service
systemctl daemon-reload
systemctl enable naoned
systemctl restart naoned

echo "==> Nginx + HTTPS"
render "$SRC_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/naoned
ln -sf /etc/nginx/sites-available/naoned /etc/nginx/sites-enabled/naoned
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect || \
  echo "!! certbot a échoué : vérifiez que $DOMAIN pointe vers $PUBLIC_IP puis relancez : certbot --nginx -d $DOMAIN"

echo "==> Pare-feu"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw allow 5060/udp
ufw allow 10000:10999/udp
ufw --force enable

cat > /etc/fail2ban/jail.d/asterisk.local <<'JAIL'
[asterisk]
enabled = true
filter = asterisk
logpath = /var/log/asterisk/messages*
maxretry = 5
bantime = 86400
JAIL
systemctl restart fail2ban || true

echo
echo "✅ Installation terminée"
echo "   Tableau de bord : https://${DOMAIN}"
echo "   Softphone test  : utilisateur 6001 / mot de passe ${TEST_PHONE_PASSWORD} / domaine ${PUBLIC_IP} → composez le 100"
echo "   Vérifier le trunk : asterisk -rx 'pjsip show registrations'"
echo "   Logs app          : journalctl -u naoned -f"
