import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Message, SessionMeta, UserMeta, Visibility } from '@company/protocol'

const DB_PATH = process.env.DB_PATH ?? './data/hub.db'

mkdirSync(dirname(DB_PATH), { recursive: true })
export const db = new DatabaseSync(DB_PATH)

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS hosts (
    id        TEXT PRIMARY KEY,
    owner_id  TEXT NOT NULL REFERENCES users(id),
    name      TEXT NOT NULL,
    platform  TEXT NOT NULL DEFAULT '',
    token     TEXT NOT NULL UNIQUE,
    -- JSON ModelInfo[]; diisi agent setelah enumerasi.
    models    TEXT NOT NULL DEFAULT '[]',
    last_seen INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id                TEXT PRIMARY KEY,
    host_id           TEXT NOT NULL REFERENCES hosts(id),
    owner_id          TEXT NOT NULL REFERENCES users(id),
    title             TEXT NOT NULL,
    cwd               TEXT NOT NULL,
    visibility        TEXT NOT NULL DEFAULT 'team',
    claude_session_id TEXT,
    -- seq terakhir yang sudah tahan lama di DB. Inilah yang dikirim balik ke
    -- agent sebagai resumeFrom setelah reconnect (PROTOCOL.md §3).
    acked_seq         INTEGER NOT NULL DEFAULT 0,
    -- Auto-approve: tool dijalankan tanpa menunggu keputusan owner.
    auto              INTEGER NOT NULL DEFAULT 0,
    -- NULL = pakai default Claude Code.
    model             TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );

  -- Satu row per giliran, BUKAN per delta. Delta hidup di memori hub saja.
  CREATE TABLE IF NOT EXISTS messages (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    id         TEXT NOT NULL,
    role       TEXT NOT NULL,
    blocks     TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_host  ON sessions(host_id);
`)

/**
 * Migrasi ringan: tambahkan kolom yang belum ada. `CREATE TABLE IF NOT EXISTS`
 * saja tidak cukup — tabel yang sudah terlanjur dibuat tidak ikut berubah, dan
 * satu-satunya jalan keluar jadi menghapus DB beserta seluruh transcript dan
 * token di dalamnya.
 */
function addColumn(table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (cols.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
  console.log(`[hub] migrasi: ${table}.${column} ditambahkan`)
}

addColumn('sessions', 'auto', 'INTEGER NOT NULL DEFAULT 0')
addColumn('sessions', 'model', 'TEXT')
addColumn('hosts', 'models', "TEXT NOT NULL DEFAULT '[]'")
addColumn('hosts', 'revoked', 'INTEGER NOT NULL DEFAULT 0')

// ------------------------------------------------------------------ queries

const q = {
  userByToken: db.prepare('SELECT * FROM users WHERE token = ?'),
  // Host yang sudah dicabut tidak boleh cocok, bahkan kalau token lamanya bocor.
  hostByToken: db.prepare('SELECT * FROM hosts WHERE token = ? AND revoked = 0'),
  hostById: db.prepare('SELECT * FROM hosts WHERE id = ?'),
  allUsers: db.prepare('SELECT * FROM users ORDER BY name'),
  hostsOf: db.prepare('SELECT * FROM hosts WHERE owner_id = ? ORDER BY name'),
  sessionsOf: db.prepare('SELECT * FROM sessions WHERE host_id = ? ORDER BY updated_at DESC'),
  sessionById: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  sessionsOfHost: db.prepare('SELECT id, acked_seq FROM sessions WHERE host_id = ?'),
  specsOfHost: db.prepare('SELECT id, cwd, title, auto, model FROM sessions WHERE host_id = ?'),
  setAuto: db.prepare('UPDATE sessions SET auto = ? WHERE id = ?'),
  setModel: db.prepare('UPDATE sessions SET model = ? WHERE id = ?'),
  setHostModels: db.prepare('UPDATE hosts SET models = ? WHERE id = ?'),
  insertSession: db.prepare(`
    INSERT INTO sessions (id, host_id, owner_id, title, cwd, visibility, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  touchSession: db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?'),
  setClaudeSid: db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ?'),
  setAcked: db.prepare('UPDATE sessions SET acked_seq = ? WHERE id = ? AND acked_seq < ?'),
  seenHost: db.prepare('UPDATE hosts SET last_seen = ?, platform = ?, name = ? WHERE id = ?'),
  insertMessage: db.prepare(`
    INSERT OR REPLACE INTO messages (session_id, seq, id, role, blocks, ts)
    VALUES (?, ?, ?, ?, ?, ?)`),
  messagesOf: db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq'),
}

export type UserRow = { id: string; name: string; token: string }
export type HostRow = {
  id: string
  owner_id: string
  name: string
  platform: string
  token: string
  models: string
  revoked: number
  last_seen: number
}
export type SessionRow = {
  id: string
  host_id: string
  owner_id: string
  title: string
  cwd: string
  visibility: Visibility
  claude_session_id: string | null
  acked_seq: number
  auto: number
  model: string | null
  created_at: number
  updated_at: number
}

export const userByToken = (t: string) => (q.userByToken.get(t) as UserRow) ?? null
export const hostByToken = (t: string) => (q.hostByToken.get(t) as HostRow) ?? null
export const hostById = (id: string) => (q.hostById.get(id) as HostRow) ?? null
export const sessionById = (id: string) => (q.sessionById.get(id) as SessionRow) ?? null

export function createHost(h: Omit<HostRow, 'last_seen' | 'models'>): void {
  db.prepare(
    'INSERT INTO hosts (id, owner_id, name, platform, token, last_seen) VALUES (?, ?, ?, ?, ?, 0)',
  ).run(h.id, h.owner_id, h.name, h.platform, h.token)
}

export function specsOfHost(hostId: string) {
  const rows = q.specsOfHost.all(hostId) as {
    id: string
    cwd: string
    title: string
    auto: number
    model: string | null
  }[]
  return rows.map((r) => ({
    sessionId: r.id,
    cwd: r.cwd,
    title: r.title,
    auto: !!r.auto,
    model: r.model,
  }))
}

export function setAuto(sessionId: string, auto: boolean): void {
  q.setAuto.run(auto ? 1 : 0, sessionId)
}

export function setModel(sessionId: string, model: string | null): void {
  q.setModel.run(model, sessionId)
}

/**
 * Cabut pairing sebuah laptop.
 *
 * Token juga dirotasi, bukan cuma ditandai: kalau nilai lamanya sempat bocor
 * (itu justru alasan orang menekan tombol ini), menandai saja menyisakan
 * rahasia yang masih bisa dicocokkan seandainya flag pernah terlewat di
 * suatu query.
 *
 * Host yang tidak punya session dihapus sekalian supaya daftar tetap bersih.
 * Yang punya session DIPERTAHANKAN — menghapusnya akan ikut membawa seluruh
 * transcript, dan mencabut kredensial bukan alasan untuk menghancurkan riwayat.
 */
export function revokeHost(hostId: string): { deleted: boolean } {
  const n = (
    db.prepare('SELECT COUNT(*) c FROM sessions WHERE host_id = ?').get(hostId) as { c: number }
  ).c

  if (n === 0) {
    db.prepare('DELETE FROM hosts WHERE id = ?').run(hostId)
    return { deleted: true }
  }

  db.prepare('UPDATE hosts SET revoked = 1, token = ? WHERE id = ?').run(
    `revoked_${randomBytes(16).toString('hex')}`,
    hostId,
  )
  return { deleted: false }
}

export function setHostModels(hostId: string, models: unknown): void {
  q.setHostModels.run(JSON.stringify(models), hostId)
}

export function sessionIdsOfHost(hostId: string): string[] {
  return (q.sessionsOfHost.all(hostId) as { id: string }[]).map((r) => r.id)
}

export function resumeMapFor(hostId: string): Record<string, number> {
  const rows = q.sessionsOfHost.all(hostId) as { id: string; acked_seq: number }[]
  return Object.fromEntries(rows.map((r) => [r.id, r.acked_seq]))
}

export function markHostSeen(hostId: string, name: string, platform: string): void {
  q.seenHost.run(Date.now(), platform, name, hostId)
}

export function createSession(
  s: Omit<
    SessionRow,
    'claude_session_id' | 'acked_seq' | 'auto' | 'model' | 'created_at' | 'updated_at'
  >,
): void {
  const now = Date.now()
  q.insertSession.run(s.id, s.host_id, s.owner_id, s.title, s.cwd, s.visibility, now, now)
}

export function setClaudeSessionId(sessionId: string, claudeSid: string): void {
  q.setClaudeSid.run(claudeSid, sessionId)
}

export function persistMessage(sessionId: string, seq: number, m: Message): void {
  q.insertMessage.run(sessionId, seq, m.id, m.role, JSON.stringify(m.blocks), m.ts)
  q.touchSession.run(Date.now(), sessionId)
}

/** Menaikkan watermark durable. Agent boleh membuang frame ≤ seq ini. */
export function ackSeq(sessionId: string, seq: number): void {
  q.setAcked.run(seq, sessionId, seq)
}

export function messagesOf(sessionId: string): Message[] {
  const rows = q.messagesOf.all(sessionId) as {
    id: string
    role: 'user' | 'assistant'
    blocks: string
    ts: number
  }[]
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    blocks: JSON.parse(r.blocks),
    ts: r.ts,
  }))
}

/**
 * Roster lengkap: User → Host → Session. `visibleTo` menyaring session privat
 * milik orang lain — penyaringan terjadi di sini, bukan di UI.
 */
export function roster(
  visibleTo: string,
  liveStatus: (sessionId: string) => SessionMeta['status'],
  isOnline: (hostId: string) => boolean,
): UserMeta[] {
  const users = q.allUsers.all() as UserRow[]
  return users.map((u) => ({
    id: u.id,
    name: u.name,
    hosts: (q.hostsOf.all(u.id) as HostRow[]).map((h) => ({
      id: h.id,
      name: h.name,
      platform: h.platform,
      online: isOnline(h.id),
      revoked: !!h.revoked,
      models: JSON.parse(h.models || '[]'),
      sessions: (q.sessionsOf.all(h.id) as SessionRow[])
        .filter((s) => s.visibility !== 'private' || s.owner_id === visibleTo)
        .map((s) => ({
          id: s.id,
          title: s.title,
          cwd: s.cwd,
          hostId: s.host_id,
          ownerId: s.owner_id,
          visibility: s.visibility,
          auto: !!s.auto,
          model: s.model,
          status: isOnline(h.id) ? liveStatus(s.id) : ('offline' as const),
          updatedAt: s.updated_at,
        })),
    })),
  }))
}

export function canRead(s: SessionRow, userId: string): boolean {
  return s.visibility !== 'private' || s.owner_id === userId
}

/**
 * Prompt/interrupt/approve: OWNER SAJA. Ditegakkan di hub, bukan di UI —
 * tombol yang di-disable bukan kontrol akses. Lihat PROTOCOL.md §5 untuk
 * alasan kenapa batas ini bukan sekadar soal keamanan.
 */
export function canWrite(s: SessionRow, userId: string): boolean {
  return s.owner_id === userId
}
