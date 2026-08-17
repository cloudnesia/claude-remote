import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { GeneralMeta, LaneMeta, Message, SessionMeta, UserMeta, Visibility } from '@company/protocol'

/**
 * `JSON.parse` yang tidak pernah melempar. Dipakai untuk kolom TEXT berisi
 * JSON (blocks, models) yang dibaca lewat roster/snapshot — query yang sama
 * dijalankan untuk BANYAK user sekaligus tiap koneksi masuk. Satu baris korup
 * (harusnya tidak mungkin, tapi disk/migrasi lama bisa saja meninggalkan
 * sisa) tidak boleh melempar exception tak tertangkap yang menjatuhkan
 * seluruh proses hub untuk semua orang — mendingan satu baris tampil kosong.
 */
function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

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

  -- General session: wadah lintas node. Sengaja tabel terpisah, bukan sessions
  -- dengan host_id NULL — kolom itu NOT NULL sejak awal dan SQLite tidak bisa
  -- melonggarkannya lewat ALTER. Isinya tetap session biasa (lihat kolom
  -- sessions.general_id), jadi seq/replay/transcript tidak berubah sama sekali.
  CREATE TABLE IF NOT EXISTS generals (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL REFERENCES users(id),
    title      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
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
// Base URL gateway saja. Kuncinya SENGAJA tidak punya kolom di sini — hub
// meneruskannya ke agent dan melupakannya (lihat PROTOCOL.md §7).
addColumn('hosts', 'gateway_url', 'TEXT')
// NULL = session biasa. Terisi = lane milik sebuah general session.
addColumn('sessions', 'general_id', 'TEXT')
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_general ON sessions(general_id)')

// ------------------------------------------------------------------ queries

const q = {
  userByToken: db.prepare('SELECT * FROM users WHERE token = ?'),
  // Host yang sudah dicabut tidak boleh cocok, bahkan kalau token lamanya bocor.
  hostByToken: db.prepare('SELECT * FROM hosts WHERE token = ? AND revoked = 0'),
  hostById: db.prepare('SELECT * FROM hosts WHERE id = ?'),
  allUsers: db.prepare('SELECT * FROM users ORDER BY name'),
  hostsOf: db.prepare('SELECT * FROM hosts WHERE owner_id = ? ORDER BY name'),
  // Lane tidak ikut: tempatnya di bawah general session, bukan di bawah host.
  sessionsOf: db.prepare(
    'SELECT * FROM sessions WHERE host_id = ? AND general_id IS NULL ORDER BY updated_at DESC',
  ),
  generalsOf: db.prepare('SELECT * FROM generals WHERE owner_id = ? ORDER BY updated_at DESC'),
  generalById: db.prepare('SELECT * FROM generals WHERE id = ?'),
  insertGeneral: db.prepare(
    'INSERT INTO generals (id, owner_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ),
  touchGeneral: db.prepare('UPDATE generals SET updated_at = ? WHERE id = ?'),
  lanesOf: db.prepare('SELECT * FROM sessions WHERE general_id = ? ORDER BY created_at'),
  laneAt: db.prepare(
    'SELECT * FROM sessions WHERE general_id = ? AND host_id = ? AND cwd = ?',
  ),
  lastLane: db.prepare(
    'SELECT cwd FROM sessions WHERE general_id = ? AND host_id = ? ORDER BY updated_at DESC LIMIT 1',
  ),
  sessionById: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  sessionsOfHost: db.prepare('SELECT id, acked_seq FROM sessions WHERE host_id = ?'),
  specsOfHost: db.prepare('SELECT id, cwd, title, auto, model FROM sessions WHERE host_id = ?'),
  setAuto: db.prepare('UPDATE sessions SET auto = ? WHERE id = ?'),
  setModel: db.prepare('UPDATE sessions SET model = ? WHERE id = ?'),
  setHostModels: db.prepare('UPDATE hosts SET models = ? WHERE id = ?'),
  setHostGateway: db.prepare('UPDATE hosts SET gateway_url = ? WHERE id = ?'),
  insertSession: db.prepare(`
    INSERT INTO sessions
      (id, host_id, owner_id, title, cwd, visibility, general_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  touchSession: db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
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
  /** Base URL gateway, atau null kalau host memakai login Claude lokalnya. */
  gateway_url: string | null
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
  /** Null untuk session biasa; terisi kalau ini lane sebuah general session. */
  general_id: string | null
  created_at: number
  updated_at: number
}

export type GeneralRow = {
  id: string
  owner_id: string
  title: string
  created_at: number
  updated_at: number
}

export const userByToken = (t: string) => (q.userByToken.get(t) as UserRow) ?? null
export const hostByToken = (t: string) => (q.hostByToken.get(t) as HostRow) ?? null
export const hostById = (id: string) => (q.hostById.get(id) as HostRow) ?? null
export const sessionById = (id: string) => (q.sessionById.get(id) as SessionRow) ?? null
export const hostsOf = (ownerId: string) => q.hostsOf.all(ownerId) as HostRow[]

export function createHost(
  h: Omit<HostRow, 'last_seen' | 'models' | 'revoked' | 'gateway_url'>,
): void {
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
 * Cabut pairing sebuah laptop — permanen, dan tuntas.
 *
 * "Lepas" berarti benar-benar hilang: node-nya dan SELURUH session +
 * transcript miliknya dihapus dari DB (baris `messages` ikut terbawa lewat
 * ON DELETE CASCADE di kolom `session_id`), lalu row host-nya sendiri
 * dibuang sekalian supaya tidak ada nama mati yang nyangkut di sidebar.
 * Token tidak perlu dirotasi lagi — barisnya sudah tidak ada.
 */
export function revokeHost(hostId: string): { deletedSessionIds: string[] } {
  const deletedSessionIds = sessionIdsOfHost(hostId)
  db.prepare('DELETE FROM sessions WHERE host_id = ?').run(hostId)
  db.prepare('DELETE FROM hosts WHERE id = ?').run(hostId)
  return { deletedSessionIds }
}

/**
 * Hapus session beserta seluruh transcript-nya. Permanen.
 *
 * Baris `messages` ikut terbawa lewat ON DELETE CASCADE — `PRAGMA
 * foreign_keys = ON` di atas yang membuatnya benar-benar jalan; tanpa pragma
 * itu SQLite diam saja dan meninggalkan ribuan baris yatim yang tidak akan
 * pernah terbaca lagi.
 */
export function deleteSession(id: string): void {
  q.deleteSession.run(id)
}

/**
 * Host yang sudah dicabut dan tidak lagi memegang session apa pun: buang.
 * Menyimpan transcript adalah satu-satunya alasan row-nya dipertahankan saat
 * pencabutan (lihat `revokeHost`), jadi begitu session terakhirnya dihapus
 * yang tersisa cuma nama mati di sidebar.
 */
export function pruneRevokedHost(hostId: string): boolean {
  const h = hostById(hostId)
  if (!h || !h.revoked) return false
  const n = (
    db.prepare('SELECT COUNT(*) c FROM sessions WHERE host_id = ?').get(hostId) as { c: number }
  ).c
  if (n > 0) return false
  db.prepare('DELETE FROM hosts WHERE id = ?').run(hostId)
  return true
}

export function setHostModels(hostId: string, models: unknown): void {
  q.setHostModels.run(JSON.stringify(models), hostId)
}

/**
 * Catat gateway sebuah host. Hanya base URL — dipanggil dari laporan agent,
 * bukan saat hub meneruskan perintah, karena yang menentukan adalah file di
 * laptop dan perintahnya bisa saja tidak sampai.
 */
export function setHostGateway(hostId: string, baseUrl: string | null): void {
  q.setHostGateway.run(baseUrl, hostId)
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
    'claude_session_id' | 'acked_seq' | 'auto' | 'model' | 'created_at' | 'updated_at' | 'general_id'
  > & { general_id?: string | null },
): void {
  const now = Date.now()
  q.insertSession.run(
    s.id,
    s.host_id,
    s.owner_id,
    s.title,
    s.cwd,
    s.visibility,
    s.general_id ?? null,
    now,
    now,
  )
}

// ------------------------------------------------------------------ general

export const generalById = (id: string) => (q.generalById.get(id) as GeneralRow) ?? null

export function createGeneral(g: Omit<GeneralRow, 'created_at' | 'updated_at'>): void {
  const now = Date.now()
  q.insertGeneral.run(g.id, g.owner_id, g.title, now, now)
}

export function touchGeneral(id: string): void {
  q.touchGeneral.run(Date.now(), id)
}

export const lanesOf = (generalId: string) => q.lanesOf.all(generalId) as SessionRow[]

/**
 * Hapus general session beserta SELURUH lane + transcript-nya. Permanen.
 *
 * Lane adalah baris `sessions` biasa (lihat `ensureLane`), jadi menghapusnya
 * ikut membawa `messages` lewat ON DELETE CASCADE — sama seperti
 * `deleteSession`, cuma sekaligus untuk semua node yang pernah ikut general
 * ini. Return baris lane yang terhapus (lengkap dengan host_id-nya), dipakai
 * pemanggil untuk memberhentikan proses di tiap agent dan membersihkan
 * subscription browser.
 */
export function deleteGeneral(generalId: string): { lanes: SessionRow[] } {
  const lanes = lanesOf(generalId)
  db.prepare('DELETE FROM sessions WHERE general_id = ?').run(generalId)
  db.prepare('DELETE FROM generals WHERE id = ?').run(generalId)
  return { lanes }
}

/** Lane dikunci per (host, cwd): node yang sama di direktori lain = lane lain. */
export const laneAt = (generalId: string, hostId: string, cwd: string) =>
  (q.laneAt.get(generalId, hostId, cwd) as SessionRow) ?? null

/** Direktori lane yang paling belakangan dipakai node ini. Null kalau belum ada. */
export const lastLaneCwd = (generalId: string, hostId: string): string | null =>
  (q.lastLane.get(generalId, hostId) as { cwd: string } | undefined)?.cwd ?? null

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
    blocks: safeJson(r.blocks, []),
    ts: r.ts,
  }))
}

/**
 * Susunan lane sebuah general session, lengkap dengan status hidupnya. Dipakai
 * roster (buat sidebar) dan pesan `general` (buat pane) — satu sumber supaya
 * keduanya tidak pernah beda.
 */
export function lanesMeta(
  generalId: string,
  liveStatus: (sessionId: string) => SessionMeta['status'],
  isOnline: (hostId: string) => boolean,
): LaneMeta[] {
  return lanesOf(generalId).map((l) => {
    const h = hostById(l.host_id)
    const online = isOnline(l.host_id)
    return {
      sessionId: l.id,
      hostId: l.host_id,
      hostName: h?.name ?? 'node',
      cwd: l.cwd,
      online,
      status: online ? liveStatus(l.id) : ('offline' as const),
    }
  })
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
    // General session tidak punya visibility per-session seperti session biasa,
    // jadi ia tidak pernah bocor ke roster orang lain sama sekali.
    generals:
      u.id === visibleTo
        ? (q.generalsOf.all(u.id) as GeneralRow[]).map(
            (g): GeneralMeta => ({
              id: g.id,
              title: g.title,
              ownerId: g.owner_id,
              updatedAt: g.updated_at,
              lanes: lanesMeta(g.id, liveStatus, isOnline),
            }),
          )
        : [],
    hosts: (q.hostsOf.all(u.id) as HostRow[]).map((h) => ({
      id: h.id,
      name: h.name,
      platform: h.platform,
      online: isOnline(h.id),
      revoked: !!h.revoked,
      models: safeJson(h.models || '[]', []),
      gateway: h.gateway_url ?? null,
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
