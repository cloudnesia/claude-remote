/**
 * Seed dev. Bikin dua user + satu host masing-masing, lalu cetak tokennya.
 * Idempotent — aman dijalankan berulang.
 *
 * Ini BUKAN pengganti device-code pairing untuk produksi; ini cuma supaya
 * end-to-end bisa jalan tanpa bikin flow login dulu.
 */
import { db } from './db.ts'
import { randomBytes } from 'node:crypto'

const tok = (p: string) => `${p}_${randomBytes(12).toString('hex')}`

const people = [
  { id: 'u_savana', name: 'Savana', host: 'Savana-Laptop' },
  { id: 'u_rekan', name: 'Rekan', host: 'Rekan-Desktop' },
]

const insUser = db.prepare('INSERT OR IGNORE INTO users (id, name, token) VALUES (?, ?, ?)')
const insHost = db.prepare(
  'INSERT OR IGNORE INTO hosts (id, owner_id, name, platform, token) VALUES (?, ?, ?, ?, ?)',
)
const getUser = db.prepare('SELECT token FROM users WHERE id = ?')
const getHost = db.prepare('SELECT token FROM hosts WHERE id = ?')

const existed = (db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n > 0

console.log('\n=== token dev ===\n')

for (const p of people) {
  const hostId = `h_${p.id.slice(2)}`
  insUser.run(p.id, p.name, tok('usr'))
  insHost.run(hostId, p.id, p.host, process.platform, tok('hst'))

  const u = getUser.get(p.id) as { token: string }
  const h = getHost.get(hostId) as { token: string }
  console.log(`${p.name.padEnd(8)} USER_TOKEN=${u.token}`)
  console.log(`${''.padEnd(8)} HOST_TOKEN=${h.token}   (${p.host}, dev saja)\n`)
}

if (existed) {
  console.log('User sudah ada — token di atas TIDAK berubah (INSERT OR IGNORE).\n')
}

console.log('Web:    buka http://localhost:5173/?token=<USER_TOKEN>')
console.log('Agent:  npm run agent -- login     (jalur normal, pakai kode pairing)')
console.log('        HOST_TOKEN=<...> npm run agent   (pintasan dev)\n')
console.log('Catatan: token disimpan di ./data/hub.db. Menghapus folder data/')
console.log('membuat SEMUA token lama mati, dan web akan menolak login dengan')
console.log('pesan "token user tidak valid". Jalankan seed lagi lalu pakai yang baru.\n')
