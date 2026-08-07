import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Gateway } from '@company/protocol'
import { DIR } from './config.ts'

/**
 * Gateway LLM laptop ini. Disimpan TERPISAH dari config pairing: umurnya
 * berbeda (boleh diganti kapan saja tanpa menyentuh host token), dan agent
 * yang dijalankan lewat `HOST_TOKEN` dari env sama sekali tidak punya
 * config.json — menumpangkan kunci di sana akan membuat file setengah jadi
 * yang lalu dibaca sebagai pairing yang rusak.
 */
const FILE = join(DIR, 'gateway.json')

export function read(): Gateway | null {
  try {
    const g = JSON.parse(readFileSync(FILE, 'utf8')) as Gateway
    return g.baseUrl && g.apiKey ? g : null
  } catch {
    return null
  }
}

export function write(g: Gateway): void {
  mkdirSync(dirname(FILE), { recursive: true })
  writeFileSync(FILE, JSON.stringify(g, null, 2))
  // Isinya kunci berbayar milik user. Perlakuan sama seperti host token.
  chmodSync(FILE, 0o600)
}

export function clear(): void {
  rmSync(FILE, { force: true })
}

/**
 * Environment untuk proses Claude Code, atau null kalau node ini memakai login
 * Claude lokalnya seperti biasa.
 *
 * `ANTHROPIC_AUTH_TOKEN` sengaja dikosongkan, bukan dibiarkan: kalau user
 * kebetulan punya nilainya di shell profile, nilai itu ikut terwarisi ke sini
 * dan menang atas kunci gateway — gejalanya 401 dari endpoint yang kredensialnya
 * kelihatan sudah benar.
 */
export function env(): Record<string, string> | null {
  const g = read()
  if (!g) return null
  return {
    ...(process.env as Record<string, string>),
    ANTHROPIC_BASE_URL: g.baseUrl,
    ANTHROPIC_API_KEY: g.apiKey,
    ANTHROPIC_AUTH_TOKEN: '',
    // Tanpa ini daftar model yang dienumerasi tetap daftar bawaan Claude Code,
    // bukan yang benar-benar dilayani gateway.
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  }
}
