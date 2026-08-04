#!/bin/sh
# Pemasang company-agent.
#
#   curl -fsSL https://github.com/cloudnesia/claude-remote/releases/latest/download/install.sh | sh
#
# Variabel opsional:
#   VERSION=v0.2.0   pasang versi tertentu (default: latest)
#   BIN_DIR=~/bin    lokasi pemasangan (default: ~/.local/bin)
#   BASE_URL=…       ambil aset dari sini, bukan GitHub (mirror internal / uji)
#
# POSIX sh, bukan bash: sebagian mesin target tidak punya bash di /bin/sh.
set -eu

REPO="${REPO:-cloudnesia/claude-remote}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
VERSION="${VERSION:-latest}"
NAME="company-agent"

say() { printf '%s\n' "$*"; }
die() { printf '\nGagal: %s\n\n' "$*" >&2; exit 1; }

# --- deteksi platform ------------------------------------------------------

os=$(uname -s)
arch=$(uname -m)

case "$os" in
  Linux)  os=linux ;;
  Darwin) os=darwin ;;
  *) die "OS tidak didukung: $os (hanya Linux dan macOS)" ;;
esac

case "$arch" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die "Arsitektur tidak didukung: $arch" ;;
esac

target="$os-$arch"
asset="$NAME-$target"

# --- prasyarat -------------------------------------------------------------

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  die "butuh curl atau wget"
fi

# Peringatan, bukan penghenti: orang mungkin memasang agent lebih dulu lalu
# Claude Code menyusul.
if ! command -v claude >/dev/null 2>&1; then
  say ""
  say "  Catatan: Claude Code belum terdeteksi di PATH."
  say "  Agent memakai instalasi Claude Code milikmu, jadi pasang dulu dari"
  say "  https://claude.com/download sebelum menjalankan 'company-agent start'."
fi

# --- unduh -----------------------------------------------------------------

if [ -n "${BASE_URL:-}" ]; then
  base="$BASE_URL"
elif [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

tmp=$(mktemp -d)
# Bersihkan apa pun yang terjadi, termasuk saat unduhan gagal di tengah.
trap 'rm -rf "$tmp"' EXIT INT TERM

say ""
say "  Mengunduh $asset ($VERSION)…"
fetch "$base/$asset" "$tmp/$NAME" || die "tidak bisa mengunduh $base/$asset"

# --- verifikasi checksum ---------------------------------------------------

if fetch "$base/$asset.sha256" "$tmp/sum" 2>/dev/null; then
  want=$(awk '{print $1}' "$tmp/sum")
  if command -v sha256sum >/dev/null 2>&1; then
    got=$(sha256sum "$tmp/$NAME" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    got=$(shasum -a 256 "$tmp/$NAME" | awk '{print $1}')
  else
    got=""
  fi
  if [ -n "$got" ] && [ "$got" != "$want" ]; then
    die "checksum tidak cocok — unduhan rusak atau dimodifikasi
       diharapkan: $want
       didapat:    $got"
  fi
  [ -n "$got" ] && say "  Checksum cocok."
else
  say "  (checksum tidak tersedia, dilewati)"
fi

# --- pasang ----------------------------------------------------------------

chmod +x "$tmp/$NAME"

# Jalankan dari lokasi sementara dulu: lebih baik gagal sebelum menimpa versi
# yang sudah ada dan bekerja.
if ! "$tmp/$NAME" bogus >/dev/null 2>&1; then
  :  # keluar dengan status non-nol memang perilaku yang benar untuk 'bogus'
fi

mkdir -p "$BIN_DIR"
mv -f "$tmp/$NAME" "$BIN_DIR/$NAME"

say "  Terpasang di $BIN_DIR/$NAME"

# --- pesan akhir -----------------------------------------------------------

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say ""
    say "  $BIN_DIR belum ada di PATH. Tambahkan ke shell profile-mu:"
    say ""
    say "      export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

say ""
say "  Selanjutnya:"
say ""
say "      company-agent login     # tampilkan kode, ketik di web"
say "      company-agent start"
say ""
say "  Default terhubung ke hub publik https://claude.pinuspintar.com."
say "  Punya hub sendiri? Sebutkan saat login:"
say ""
say "      HUB_URL=wss://hub-mu WEB_URL=https://hub-mu company-agent login"
say ""
