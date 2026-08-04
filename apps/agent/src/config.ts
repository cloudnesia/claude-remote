import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Config = { hubUrl: string; hostId: string; hostToken: string; hostName: string }

/**
 * Deployment publik. Laptop yang baru memasang agent lewat `install.sh` tidak
 * punya cara menebak alamat hub, jadi default-nya harus yang sungguhan —
 * bukan localhost, yang selalu gagal di mesin orang lain. Override lewat
 * `HUB_URL` / `WEB_URL` untuk hub sendiri atau saat dev.
 */
export const DEFAULT_HUB_URL = 'wss://remote.deployaja.id'
export const DEFAULT_WEB_URL = 'https://remote.deployaja.id'

export const DIR = process.env.AGENT_HOME ?? join(homedir(), '.company-agent')
const FILE = join(DIR, 'config.json')

export function read(): Config | null {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'))
  } catch {
    return null
  }
}

export function write(c: Config): void {
  mkdirSync(dirname(FILE), { recursive: true })
  writeFileSync(FILE, JSON.stringify(c, null, 2))
  // Isinya setara kunci akses shell ke mesin ini.
  chmodSync(FILE, 0o600)
}

export function clear(): void {
  rmSync(FILE, { force: true })
}
