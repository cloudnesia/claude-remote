import { query } from '@anthropic-ai/claude-agent-sdk'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelInfo } from '@company/protocol'
import { DIR } from './config.ts'
import { claudeSpawnOptions } from './claude.ts'

const FILE = join(DIR, 'models.json')

/**
 * Daftar model harus ditanya ke Claude Code lokal — hub tidak boleh
 * menebaknya, karena yang tersedia bergantung pada akun dan versi CLI di
 * laptop ini.
 *
 * `supportedModels()` adalah control request: ia butuh proses hidup, tapi
 * TIDAK melakukan inference sama sekali. Jadi ini gratis dari sisi token,
 * hanya ~2 detik spawn.
 */
export async function enumerate(cwd: string): Promise<ModelInfo[]> {
  // Input stream yang menunggu, tapi BISA diakhiri. Versi yang menunggu
  // selamanya (`new Promise(() => {})`) membuat generator tidak pernah bisa
  // ditutup — `q.return()` ikut menggantung dan proses Claude Code tertinggal
  // sebagai yatim, ~200MB per start agent.
  let release!: () => void
  const closed = new Promise<void>((r) => (release = r))
  async function* idle(): AsyncGenerator<never> {
    await closed
  }

  const q = query({ prompt: idle(), options: { cwd, ...claudeSpawnOptions() } })
  try {
    return (await q.supportedModels()) as ModelInfo[]
  } finally {
    release() // input selesai → SDK menutup stdin → CLI keluar
    try {
      await q.return(undefined as never)
    } catch {
      /* sudah tertutup */
    }
  }
}

export function readCache(): ModelInfo[] {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'))
  } catch {
    return []
  }
}

export function writeCache(models: ModelInfo[]): void {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(models, null, 2))
}
