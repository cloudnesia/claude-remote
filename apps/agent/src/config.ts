import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Config = { hubUrl: string; hostId: string; hostToken: string; hostName: string }

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
