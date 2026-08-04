import { hostname, platform } from 'node:os'
import * as config from './config.ts'

/**
 * Sisi agent dari device-code pairing. Agent minta kode, user mengetiknya di
 * web, agent poll sampai diklaim. Token user tidak pernah lewat sini.
 */
export async function login(hubHttp: string, hubWs: string): Promise<void> {
  const hostName = process.env.HOST_NAME ?? hostname()

  const res = await fetch(`${hubHttp}/pair/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostName, platform: platform() }),
  })
  if (!res.ok) throw new Error(`hub menolak: HTTP ${res.status}`)

  const { code, pollToken, expiresInSec } = (await res.json()) as {
    code: string
    pollToken: string
    expiresInSec: number
  }

  const webUrl = process.env.WEB_URL ?? config.DEFAULT_WEB_URL
  console.log(`\n  Buka  ${webUrl}  lalu masukkan kode ini:\n`)
  console.log(`      ${code}\n`)
  console.log(`  Berlaku ${Math.floor(expiresInSec / 60)} menit. Menunggu…`)

  const deadline = Date.now() + expiresInSec * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))

    const pr = await fetch(`${hubHttp}/pair/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pollToken }),
    })
    const p = (await pr.json()) as {
      status: 'pending' | 'claimed' | 'expired' | 'unknown'
      hostId?: string
      hostToken?: string
    }

    if (p.status === 'claimed') {
      config.write({ hubUrl: hubWs, hostId: p.hostId!, hostToken: p.hostToken!, hostName })
      console.log(`\n  Terhubung sebagai "${hostName}". Jalankan: company-agent start\n`)
      return
    }
    if (p.status === 'expired' || p.status === 'unknown') break
  }

  throw new Error('kode kedaluwarsa sebelum diklaim')
}
