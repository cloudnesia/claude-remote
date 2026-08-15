#!/usr/bin/env bash
# Bersihkan node berstatus "dilepas" (revoked) yang masih nyangkut di DB.
#
# Sebelum fix "hapus node tuntas" (lihat apps/hub/src/db.ts revokeHost),
# node yang dilepas padahal masih punya session hanya ditandai revoked=1 —
# row-nya tetap ada dan tampil di sidebar berlabel "dilepas". Sejak fix itu
# unbind_host baru tidak lagi meninggalkan sisa begini, tapi DB lama (yang
# sudah jalan sebelum fix) bisa masih punya baris semacam ini. Skrip ini
# menuntaskannya: hapus node + seluruh session & transcript miliknya
# (`messages` ikut lewat ON DELETE CASCADE), sama seperti yang sekarang
# dilakukan unbind_host di jalur normal.
#
# Pemakaian:
#   apps/hub/scripts/cleanup-revoked-hosts.sh              # preview (dry-run)
#   apps/hub/scripts/cleanup-revoked-hosts.sh --apply       # eksekusi beneran
#   DB_PATH=/path/lain/hub.db ...  --apply                  # DB lain
#
# Hub sebaiknya TIDAK sedang jalan saat --apply dipakai (SQLite WAL cukup
# toleran untuk write bersamaan, tapi lebih aman kalau tidak ada proses lain
# yang menulis di tengah pembersihan ini).

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../../.." # -> root repo

DB_PATH="${DB_PATH:-./data/hub.db}"
APPLY=0

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Argumen tidak dikenal: $arg (pakai --apply atau --help)" >&2
      exit 1
      ;;
  esac
done

if [ ! -f "$DB_PATH" ]; then
  echo "DB tidak ditemukan di $DB_PATH (set DB_PATH= kalau lokasinya beda)" >&2
  exit 1
fi

if [ "$APPLY" = 1 ]; then
  db_dir="$(dirname "$DB_PATH")"
  # SQLite butuh nulis ke DIREKTORI-nya juga (file -wal/-shm/-journal di
  # sebelah hub.db), jadi file-nya writable saja tidak cukup. Ini penyebab
  # paling umum "attempt to write a readonly database" di deployment
  # install-server.sh: $STATE (/var/lib/claude-remote) di-chown ke user
  # service (claude-remote), bukan ke user yang menjalankan skrip ini.
  if [ ! -w "$DB_PATH" ] || [ ! -w "$db_dir" ]; then
    owner="$(stat -c '%U' "$DB_PATH" 2>/dev/null || stat -f '%Su' "$DB_PATH" 2>/dev/null || echo '?')"
    cat >&2 <<EOF
Tidak punya izin tulis ke $DB_PATH atau direktorinya ($db_dir).
Pemiliknya: $owner — jalankan sebagai user itu, mis.:

  sudo -u $owner DB_PATH=$DB_PATH $0 --apply

(SQLite perlu menulis file -wal/-shm di direktori yang sama, jadi file
db-nya writable saja tidak cukup — direktorinya juga harus writable oleh
user yang menjalankan skrip ini.)
EOF
    exit 1
  fi
fi

DB_PATH="$DB_PATH" APPLY="$APPLY" node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite'

const dbPath = process.env.DB_PATH
const apply = process.env.APPLY === '1'

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA foreign_keys = ON;')

const hosts = db
  .prepare(\"SELECT id, name, owner_id FROM hosts WHERE revoked = 1\")
  .all()

if (hosts.length === 0) {
  console.log('Tidak ada node berstatus dilepas yang nyangkut. Bersih.')
  process.exit(0)
}

const sessionCount = db.prepare('SELECT COUNT(*) c FROM sessions WHERE host_id = ?')

let totalSessions = 0
for (const h of hosts) {
  const n = sessionCount.get(h.id).c
  totalSessions += n
  console.log(\`- \${h.name} (\${h.id}, owner \${h.owner_id}): \${n} session\`)
}

console.log(\`\nTotal: \${hosts.length} node, \${totalSessions} session (+ seluruh transcript-nya).\`)

if (!apply) {
  console.log('\nIni cuma preview — jalankan lagi dengan --apply untuk benar-benar menghapus.')
  process.exit(0)
}

const deleteSessions = db.prepare('DELETE FROM sessions WHERE host_id = ?')
const deleteHost = db.prepare('DELETE FROM hosts WHERE id = ?')

const tx = db.prepare('BEGIN')
tx.run()
try {
  for (const h of hosts) {
    deleteSessions.run(h.id)
    deleteHost.run(h.id)
  }
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  if (err && err.errcode === 8) {
    console.error(
      \`\nDB/direktorinya masih readonly buat user ini walau cek awal lolos \` +
        \`(kemungkinan filesystem read-only atau atribut khusus, mis. chattr +i). \` +
        \`Cek: mount | grep \$(dirname \${JSON.stringify(dbPath)}), lsattr \${JSON.stringify(dbPath)}\`,
    )
  }
  throw err
}

console.log(\`\nSelesai — \${hosts.length} node dan \${totalSessions} session terhapus permanen.\`)
"
