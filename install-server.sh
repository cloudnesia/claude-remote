#!/bin/sh
# Pasang hub + web sebagai dua service systemd terpisah, sekali jalan.
#
#   curl -fsSL https://raw.githubusercontent.com/cloudnesia/claude-remote/main/install-server.sh | sudo sh
#
# atau dari dalam checkout:
#
#   sudo sh install-server.sh
#
# Variabel opsional:
#   HUB_URL=wss://hub.contoh.com   alamat hub yang dipakai browser & agent
#                                  (default: ws://<IP server>:HUB_PORT)
#   HUB_PORT=8787                  port hub
#   WEB_PORT=8080                  port UI
#   BIND=127.0.0.1                 alamat bind; pakai ini kalau ada nginx di depan
#   REF=main                       branch/tag yang dipasang
#   NODE_VERSION=v24.18.0          Node yang diunduh kalau sistem belum punya ≥24
#   SYSTEMD=0                      siapkan semuanya tapi jangan sentuh systemd
#
# POSIX sh: server minimal sering tidak punya bash di /bin/sh.
set -eu

REPO="${REPO:-cloudnesia/claude-remote}"
REF="${REF:-main}"
PREFIX="${PREFIX:-/opt/claude-remote}"
STATE="${STATE:-/var/lib/claude-remote}"
ETC="${ETC:-/etc/claude-remote}"
SVC_USER="${SVC_USER:-claude-remote}"
HUB_PORT="${HUB_PORT:-8787}"
WEB_PORT="${WEB_PORT:-8080}"
BIND="${BIND:-0.0.0.0}"
NODE_VERSION="${NODE_VERSION:-v24.18.0}"
SYSTEMD="${SYSTEMD:-1}"

APP="$PREFIX/app"
NODE_DIR="$PREFIX/node"

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die()  { printf '\nGagal: %s\n\n' "$*" >&2; exit 1; }

# --- prasyarat -------------------------------------------------------------

[ "$(id -u)" = 0 ] || die "jalankan sebagai root (sudo sh install-server.sh)"
[ "$(uname -s)" = Linux ] || die "script ini khusus Linux"

for c in tar curl; do
  command -v "$c" >/dev/null 2>&1 || die "butuh '$c'"
done

if [ "$SYSTEMD" = 1 ] && ! command -v systemctl >/dev/null 2>&1; then
  die "systemd tidak ditemukan. Jalankan dengan SYSTEMD=0 untuk menyiapkan file saja."
fi

# --- alamat hub ------------------------------------------------------------

detect_ip() {
  ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}'
}

if [ -z "${HUB_URL:-}" ]; then
  ip=$(detect_ip)
  [ -n "$ip" ] || die "tidak bisa mendeteksi IP server; set HUB_URL secara eksplisit"
  HUB_URL="ws://$ip:$HUB_PORT"
  say ""
  say "  HUB_URL tidak diset, memakai $HUB_URL"
  say "  Kalau nanti dipasang di belakang nginx dengan domain, ulangi dengan"
  say "  HUB_URL=wss://domainmu — alamat ini ditanam ke dalam build UI."
fi

# --- node ------------------------------------------------------------------

step "Menyiapkan Node"

node_ok() {
  command -v "$1" >/dev/null 2>&1 || return 1
  v=$("$1" -v 2>/dev/null | sed 's/^v//; s/\..*//')
  [ -n "$v" ] && [ "$v" -ge 24 ] 2>/dev/null
}

if node_ok node; then
  NODE_BIN=$(command -v node)
  say "  Memakai Node sistem: $NODE_BIN ($("$NODE_BIN" -v))"
elif node_ok "$NODE_DIR/bin/node"; then
  NODE_BIN="$NODE_DIR/bin/node"
  say "  Memakai Node yang sudah dipasang di $NODE_DIR"
else
  case "$(uname -m)" in
    x86_64|amd64) narch=x64 ;;
    aarch64|arm64) narch=arm64 ;;
    *) die "arsitektur tidak didukung: $(uname -m)" ;;
  esac
  tarball="node-$NODE_VERSION-linux-$narch.tar.xz"
  say "  Node ≥24 tidak ada; mengunduh $tarball"
  tmpn=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$tarball" -o "$tmpn/n.tar.xz" \
    || die "gagal mengunduh Node $NODE_VERSION"
  mkdir -p "$NODE_DIR"
  tar -xJf "$tmpn/n.tar.xz" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmpn"
  NODE_BIN="$NODE_DIR/bin/node"
  say "  Terpasang: $("$NODE_BIN" -v)"
fi

NPM_BIN="$(dirname "$NODE_BIN")/npm"
[ -x "$NPM_BIN" ] || NPM_BIN=$(command -v npm) || die "npm tidak ditemukan"

# --- sumber ----------------------------------------------------------------

step "Mengambil sumber"

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
rm -rf "$APP"
mkdir -p "$APP"

if [ -f "$here/package.json" ] && grep -q '"name": *"company"' "$here/package.json" 2>/dev/null; then
  if [ -d "$here/.git" ] && command -v git >/dev/null 2>&1; then
    # `ls-files -co --exclude-standard` = file ter-track + yang belum ter-track
    # tapi tidak diabaikan. Sengaja BUKAN `git archive HEAD`: itu hanya membawa
    # yang sudah ter-commit, jadi memasang dari checkout yang belum di-commit
    # akan diam-diam memasang versi lain daripada yang ada di layar.
    say "  Dari checkout lokal (isi direktori kerja, minus yang di-gitignore)"
    (cd "$here" && git ls-files -co --exclude-standard -z | tar -c --null -T - -f -) \
      | tar -x -C "$APP"
  else
    say "  Dari direktori lokal (salin)"
    tar -c -C "$here" --exclude=node_modules --exclude=data --exclude=.env \
      --exclude=build --exclude=.svelte-kit --exclude=dist . | tar -x -C "$APP"
  fi
else
  say "  Clone $REPO ($REF)"
  command -v git >/dev/null 2>&1 || die "butuh git untuk clone"
  git clone --depth 1 --branch "$REF" "https://github.com/$REPO.git" "$APP" -q \
    || die "gagal clone $REPO@$REF"
  rm -rf "$APP/.git"
fi

# --- build -----------------------------------------------------------------

step "Memasang dependensi (bisa beberapa menit)"
(cd "$APP" && "$NPM_BIN" ci --no-audit --no-fund >/dev/null) || die "npm ci gagal"

step "Membangun UI"
# HUB_URL ditanam saat build; UI tidak bisa menemukannya sendiri saat runtime.
(cd "$APP" && VITE_HUB_URL="$HUB_URL" "$NPM_BIN" run build --workspace=web >/dev/null) \
  || die "build web gagal"
[ -f "$APP/apps/web/build/index.html" ] || die "hasil build web tidak ditemukan"

# --- user & direktori ------------------------------------------------------

step "Menyiapkan user dan direktori"

if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin "$SVC_USER"
  say "  User sistem '$SVC_USER' dibuat"
else
  say "  User '$SVC_USER' sudah ada"
fi

mkdir -p "$STATE" "$ETC"
chown -R "$SVC_USER:$SVC_USER" "$STATE"
chown -R root:root "$PREFIX"
chmod 755 "$PREFIX"

# --- konfigurasi -----------------------------------------------------------

step "Menulis konfigurasi"

cat > "$ETC/hub.env" <<EOF
PORT=$HUB_PORT
HOST=$BIND
DB_PATH=$STATE/hub.db
EOF

cat > "$ETC/web.env" <<EOF
PORT=$WEB_PORT
HOST=$BIND
WEB_ROOT=$APP/apps/web/build
EOF

# Berisi lokasi DB dan port, bukan rahasia — tapi tidak ada alasan
# world-readable.
chmod 640 "$ETC/hub.env" "$ETC/web.env"
chown root:"$SVC_USER" "$ETC/hub.env" "$ETC/web.env"
say "  $ETC/hub.env dan $ETC/web.env"

# --- systemd ---------------------------------------------------------------

step "Menulis unit systemd"

write_unit() {
  name=$1; desc=$2; exec=$3; envfile=$4
  cat > "/etc/systemd/system/$name" <<EOF
[Unit]
Description=$desc
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$APP
EnvironmentFile=$envfile
ExecStart=$exec
Restart=always
RestartSec=2

# Pengetatan. ProtectSystem=strict membuat seluruh filesystem read-only,
# jadi ReadWritePaths di bawah adalah satu-satunya tempat service bisa menulis.
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
ReadWritePaths=$STATE

[Install]
WantedBy=multi-user.target
EOF
  say "  /etc/systemd/system/$name"
}

write_unit claude-hub.service "Claude Remote hub (WebSocket relay + DB)" \
  "$NODE_BIN $APP/apps/hub/src/index.ts" "$ETC/hub.env"

write_unit claude-web.service "Claude Remote web UI" \
  "$NODE_BIN $APP/apps/web/serve.mjs" "$ETC/web.env"

if [ "$SYSTEMD" != 1 ]; then
  say ""
  say "  SYSTEMD=0 — unit ditulis tapi tidak di-enable."
  exit 0
fi

# --- seed ------------------------------------------------------------------

fresh=0
if [ ! -f "$STATE/hub.db" ]; then
  fresh=1
  step "Membuat user awal"
  # Dijalankan sebagai service user supaya file DB langsung dimiliki dia,
  # bukan root — kalau tidak, service gagal menulis saat start.
  seed_out=$(cd "$APP" && DB_PATH="$STATE/hub.db" \
    setpriv --reuid="$SVC_USER" --regid="$SVC_USER" --clear-groups \
    "$NODE_BIN" apps/hub/src/seed.ts 2>&1) || die "seed gagal:
$seed_out"
fi

# --- start -----------------------------------------------------------------

step "Menyalakan service"
systemctl daemon-reload
systemctl enable --now claude-hub.service claude-web.service >/dev/null 2>&1 \
  || die "gagal enable service; cek: journalctl -u claude-hub -u claude-web"

sleep 2
for s in claude-hub claude-web; do
  if systemctl is-active --quiet "$s"; then
    say "  $s: aktif"
  else
    say "  $s: GAGAL"
    systemctl status "$s" --no-pager -l | tail -15
    die "service tidak jalan; lihat 'journalctl -u $s -n 50'"
  fi
done

# --- ringkasan -------------------------------------------------------------

web_host=$([ "$BIND" = "0.0.0.0" ] && detect_ip || echo "$BIND")

say ""
say "==================================================================="
say ""
say "  UI    http://$web_host:$WEB_PORT"
say "  Hub   $HUB_URL"
say ""
if [ "$fresh" = 1 ]; then
  say "$seed_out"
  say "  Simpan USER_TOKEN di atas — itu satu-satunya cara masuk ke web."
  say ""
fi
say "  Hubungkan laptop:"
say ""
say "      HUB_URL=$HUB_URL company-agent login"
say ""
say "  Kelola:"
say "      systemctl status claude-hub claude-web"
say "      journalctl -u claude-hub -f"
say ""
say "==================================================================="
say ""
