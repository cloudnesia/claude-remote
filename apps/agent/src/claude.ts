import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * Cari binary Claude Code milik user.
 *
 * Agent ini TIDAK memaketkan Claude Code — selain 275MB, versinya harus yang
 * sudah login di laptop ini. SDK men-spawn path yang kita berikan secara
 * langsung kalau ekstensinya bukan .js, jadi binary native bisa dipakai apa
 * adanya tanpa Node sama sekali.
 */
const EXTRA_DIRS = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.claude', 'local'),
  '/usr/local/bin',
  '/opt/homebrew/bin',
]

function usable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

let cached: string | null | undefined

export function resolveClaudeBin(): string | null {
  if (cached !== undefined) return cached

  const explicit = process.env.CLAUDE_BIN
  if (explicit) {
    cached = usable(explicit) ? explicit : null
    return cached
  }

  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...EXTRA_DIRS]
  for (const d of dirs) {
    const p = join(d, 'claude')
    if (usable(p)) {
      cached = p
      return cached
    }
  }

  cached = null
  return cached
}

/**
 * Opsi spawn untuk SDK. Kalau binary tidak ketemu, kembalikan objek kosong
 * supaya SDK memakai cli.js bawaannya — itu jalur yang benar saat agent
 * dijalankan dari source lewat npm, di mana paket SDK memang lengkap.
 */
export function claudeSpawnOptions(): { pathToClaudeCodeExecutable?: string } {
  const bin = resolveClaudeBin()
  return bin ? { pathToClaudeCodeExecutable: bin } : {}
}

/**
 * true kalau kita berjalan sebagai binary hasil paket.
 *
 * Ditanam saat build lewat esbuild `define`, bukan dideteksi runtime:
 * `process.versions.sea` tidak ada, dan `node:sea` API-nya masih eksperimental.
 * Flag build-time selalu benar dan tidak bisa berubah diam-diam.
 */
export const isPackaged = (): boolean => process.env.COMPANY_AGENT_PACKAGED === '1'
