import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DIR } from './config.ts'

/**
 * Registry session milik host ini. Sengaja disimpan di laptop, bukan cuma di
 * hub: `cwd` dan `claudeSessionId` itu fakta lokal, dan agent harus bisa
 * membangkitkan ulang session cold tanpa menunggu hub memberi tahu isinya.
 */
export type Entry = {
  cwd: string
  claudeSessionId?: string
  title: string
  auto?: boolean
  model?: string | null
}

const FILE = process.env.AGENT_STORE ?? join(DIR, 'sessions.json')

let cache: Record<string, Entry> = load()

function load(): Record<string, Entry> {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'))
  } catch {
    return {}
  }
}

function save(): void {
  mkdirSync(dirname(FILE), { recursive: true })
  writeFileSync(FILE, JSON.stringify(cache, null, 2))
}

export const get = (id: string): Entry | undefined => cache[id]

export function put(id: string, e: Entry): void {
  cache[id] = { ...cache[id], ...e }
  save()
}

export function remove(id: string): void {
  delete cache[id]
  save()
}
