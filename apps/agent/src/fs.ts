import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { BrowseResult } from '@company/protocol'

/** Jangan banjiri UI (dan WS) dengan direktori sebanyak /nix/store. */
const MAX_ENTRIES = 300

/**
 * `~` diperluas DI SINI, di host. Node tidak melakukannya sendiri — cwd `~/`
 * diteruskan apa adanya ke spawn dan gagal dengan pesan yang menyesatkan
 * ("spawn node ENOENT"), seolah Node yang hilang, bukan direktorinya.
 */
export function expandPath(p: string): string {
  const t = p.trim()
  if (t === '~') return homedir()
  if (t.startsWith('~/')) return join(homedir(), t.slice(2))
  return resolve(t)
}

export type CwdCheck = { ok: true; path: string } | { ok: false; reason: string }

export function checkCwd(raw: string): CwdCheck {
  if (!raw.trim()) return { ok: false, reason: 'direktori kosong' }
  const path = expandPath(raw)
  let st
  try {
    st = statSync(path)
  } catch {
    return { ok: false, reason: `direktori tidak ada di host: ${path}` }
  }
  if (!st.isDirectory()) return { ok: false, reason: `bukan direktori: ${path}` }
  return { ok: true, path }
}

export function browse(rawPath: string): BrowseResult {
  const home = homedir()
  const path = rawPath.trim() ? expandPath(rawPath) : home
  const parent = path === '/' ? null : dirname(path)

  try {
    const entries = readdirSync(path, { withFileTypes: true })
      .filter((e) => {
        if (!e.isDirectory()) return false
        // Sembunyikan dotdir dan node_modules: hampir tidak pernah jadi project
        // root, dan jumlahnya menenggelamkan yang relevan.
        return !e.name.startsWith('.') && e.name !== 'node_modules'
      })
      .slice(0, MAX_ENTRIES)
      .map((e) => ({ name: e.name, path: join(path, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))

    return { path, home, parent, entries }
  } catch (err) {
    return {
      path,
      home,
      parent,
      entries: [],
      error: (err as NodeJS.ErrnoException).code === 'EACCES' ? 'tidak punya akses' : 'tidak bisa dibaca',
    }
  }
}
