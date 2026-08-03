import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { createHost, hostById } from './db.ts'

/**
 * Device-code pairing, seperti `gh auth login` atau login app di TV.
 *
 * Agent tidak pernah memegang kredensial user, dan user tidak pernah menyalin
 * token panjang. Agent minta kode pendek, user mengetiknya di web sambil sudah
 * login, lalu hub menerbitkan host token yang identitasnya laptop itu.
 */

const TTL_MS = 5 * 60_000
/** Percobaan klaim per user per jendela. Kode pendek harus dilindungi. */
const MAX_ATTEMPTS = 10
const ATTEMPT_WINDOW_MS = 10 * 60_000

// Huruf ambigu dibuang (0/O, 1/I/L) — kode ini diketik ulang manusia.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

type Pending = {
  code: string
  pollToken: string
  hostName: string
  platform: string
  expiresAt: number
  claimed: { hostId: string; hostToken: string } | null
}

const byCode = new Map<string, Pending>()
const byPollToken = new Map<string, Pending>()
const attempts = new Map<string, { n: number; resetAt: number }>()

function sweep(): void {
  const now = Date.now()
  for (const [code, p] of byCode) {
    // Yang sudah diklaim tetap disimpan sebentar supaya agent sempat poll.
    if (p.expiresAt < now) {
      byCode.delete(code)
      byPollToken.delete(p.pollToken)
    }
  }
}
setInterval(sweep, 30_000).unref()

function makeCode(): string {
  let code = ''
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-'
    code += ALPHABET[randomInt(ALPHABET.length)]
  }
  return code
}

export function start(hostName: string, platform: string) {
  sweep()
  let code = makeCode()
  while (byCode.has(code)) code = makeCode()

  const p: Pending = {
    code,
    pollToken: randomBytes(32).toString('hex'),
    hostName,
    platform,
    expiresAt: Date.now() + TTL_MS,
    claimed: null,
  }
  byCode.set(code, p)
  byPollToken.set(p.pollToken, p)
  return { code, pollToken: p.pollToken, expiresInSec: Math.floor(TTL_MS / 1000) }
}

export function poll(pollToken: string) {
  const p = byPollToken.get(pollToken)
  if (!p) return { status: 'unknown' as const }
  if (p.expiresAt < Date.now()) return { status: 'expired' as const }
  if (!p.claimed) return { status: 'pending' as const }

  // Sekali ambil. Setelah agent menerima token, jejaknya dibuang.
  byPollToken.delete(pollToken)
  byCode.delete(p.code)
  return { status: 'claimed' as const, ...p.claimed }
}

export type ClaimResult =
  | { ok: true; hostId: string; hostName: string }
  | { ok: false; reason: string }

export function claim(userId: string, rawCode: string): ClaimResult {
  const now = Date.now()
  const a = attempts.get(userId)
  if (a && a.resetAt > now) {
    if (a.n >= MAX_ATTEMPTS) return { ok: false, reason: 'terlalu banyak percobaan, tunggu sebentar' }
    a.n++
  } else {
    attempts.set(userId, { n: 1, resetAt: now + ATTEMPT_WINDOW_MS })
  }

  const code = normalize(rawCode)
  const p = findByCode(code)
  if (!p) return { ok: false, reason: 'kode tidak ditemukan' }
  if (p.expiresAt < now) return { ok: false, reason: 'kode kedaluwarsa' }
  if (p.claimed) return { ok: false, reason: 'kode sudah dipakai' }

  const hostId = `h_${randomBytes(8).toString('hex')}`
  const hostToken = `hst_${randomBytes(24).toString('hex')}`
  createHost({
    id: hostId,
    owner_id: userId,
    name: p.hostName,
    platform: p.platform,
    token: hostToken,
  })

  p.claimed = { hostId, hostToken }
  return { ok: true, hostId, hostName: p.hostName }
}

const normalize = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^(.{4})(.{4})$/, '$1-$2')

/**
 * Pencocokan waktu-konstan atas semua kode aktif. Jumlahnya kecil, dan ini
 * menutup kebocoran timing yang bisa dipakai menebak kode karakter per karakter.
 */
function findByCode(code: string): Pending | undefined {
  const want = Buffer.from(code)
  let found: Pending | undefined
  for (const [candidate, p] of byCode) {
    const buf = Buffer.from(candidate)
    if (buf.length === want.length && timingSafeEqual(buf, want)) found = p
  }
  return found
}

/** Dipakai saat startup untuk melaporkan host yang sudah pernah dipasangkan. */
export const describeHost = (hostId: string) => hostById(hostId)
