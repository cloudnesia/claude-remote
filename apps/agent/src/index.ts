#!/usr/bin/env node
import { hostname, platform } from 'node:os'
import WebSocket from 'ws'
import { CLOSE, PROTOCOL_VERSION, safeParse, type AgentToHub, type HubToAgent } from '@company/protocol'
import { SessionRunner } from './session.ts'
import * as store from './store.ts'
import { browse } from './fs.ts'
import * as models from './models.ts'
import * as config from './config.ts'
import { login } from './login.ts'

const VERSION = '1.0.0'

const cfg = config.read()
const HUB = process.env.HUB_URL ?? cfg?.hubUrl ?? 'ws://localhost:8787'
const HUB_HTTP = HUB.replace(/^ws/, 'http')
// HOST_TOKEN dari env tetap didukung untuk dev/CI; jalur normalnya pairing.
const TOKEN = process.env.HOST_TOKEN ?? cfg?.hostToken ?? ''
const HOST_NAME = process.env.HOST_NAME ?? cfg?.hostName ?? hostname()

const runners = new Map<string, SessionRunner>()
let ws: WebSocket | null = null
let backoff = 1000
/** resumeFrom terakhir dari hub, dipakai session cold saat dibangunkan. */
let coldFloor: Record<string, number> = {}

const send = (m: AgentToHub) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
}

/**
 * Semua frame lewat sini. Selalu masuk outbox dulu (lewat runner), baru
 * dicoba dikirim — kalau WS sedang putus, frame tetap aman dan dikirim ulang
 * saat `hello` berikutnya.
 */
const emit = (frame: import('@company/protocol').Frame) => send({ t: 'frame', frame })

function runnerFor(sessionId: string): SessionRunner | null {
  const existing = runners.get(sessionId)
  if (existing) return existing

  const entry = store.get(sessionId)
  if (!entry) return null

  const r = new SessionRunner(sessionId, entry.cwd, entry.claudeSessionId, emit, (sid) => {
    store.put(sessionId, { ...entry, claudeSessionId: sid })
    send({ t: 'session_state', sessionId, alive: true, claudeSessionId: sid, cwd: entry.cwd })
  })
  r.auto = !!entry.auto
  r.model = entry.model ?? null
  runners.set(sessionId, r)
  return r
}

let refreshing = false

async function refreshModels(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    const found = await models.enumerate(process.cwd())
    if (!found.length) return
    models.writeCache(found)
    send({ t: 'models', models: found })
    console.log(`[agent] ${found.length} model tersedia: ${found.map((m) => m.value).join(', ')}`)
  } catch (err) {
    console.warn('[agent] gagal mengambil daftar model:', (err as Error).message)
  } finally {
    refreshing = false
  }
}

// ------------------------------------------------------------------ connect

function connect(): void {
  const url = `${HUB}/agent?token=${encodeURIComponent(TOKEN)}`
  ws = new WebSocket(url)

  ws.on('open', () => {
    backoff = 1000
    console.log(`[agent] terhubung ke ${HUB} sebagai ${HOST_NAME}`)
    send({ t: 'auth', v: PROTOCOL_VERSION, hostName: HOST_NAME, platform: platform(), agentVersion: VERSION })
  })

  ws.on('message', (raw) => {
    const m = safeParse<HubToAgent>(String(raw))
    if (!m) return

    switch (m.t) {
      case 'hello': {
        // Replay: kirim ulang semua yang belum dilihat hub SEBELUM frame baru,
        // supaya urutan seq tetap rapat dan hub bisa merakit ulang giliran
        // yang terpotong saat koneksi putus.
        let replayed = 0
        for (const [sid, r] of runners) {
          const from = m.resumeFrom[sid] ?? 0
          r.outbox.raiseFloor(from)
          for (const f of r.outbox.since(from)) {
            send({ t: 'frame', frame: f })
            replayed++
          }
          send({
            t: 'session_state',
            sessionId: sid,
            alive: r.alive,
            claudeSessionId: r.claudeSessionId,
            cwd: r.cwd,
          })
        }
        // Session cold (ada di disk, belum ada runner) tidak perlu apa-apa di
        // sini — floor seq-nya diambil dari hub saat nanti dibangunkan prompt.
        coldFloor = m.resumeFrom

        // Rekonsiliasi: isi session yang hub punya tapi kita belum. Tanpa ini,
        // session yang dibuat saat agent offline hilang selamanya — prompt
        // ke sana cuma menghasilkan diam.
        let restored = 0
        for (const spec of m.sessions) {
          const known = store.get(spec.sessionId)
          if (!known) restored++
          store.put(spec.sessionId, {
            cwd: known?.cwd ?? spec.cwd,
            title: known?.title ?? spec.title,
            claudeSessionId: known?.claudeSessionId,
            auto: spec.auto,
            model: spec.model,
          })
          const r = runners.get(spec.sessionId)
          if (r) {
            r.auto = spec.auto
            r.model = spec.model
          }
        }

        // Kirim daftar model. Yang di-cache dikirim dulu supaya UI langsung
        // terisi; enumerasi ulang jalan di belakang untuk menangkap perubahan
        // (upgrade CLI, ganti akun) tanpa menahan startup.
        const cached = models.readCache()
        if (cached.length) send({ t: 'models', models: cached })
        void refreshModels()

        console.log(
          `[agent] hello dari hub, ${replayed} frame di-replay` +
            (restored ? `, ${restored} session dipulihkan` : ''),
        )
        break
      }

      case 'create_session': {
        store.put(m.sessionId, { cwd: m.cwd, title: m.title, auto: m.auto })
        console.log(`[agent] session baru ${m.sessionId.slice(0, 8)} di ${m.cwd}`)
        break
      }

      case 'prompt': {
        const r = runnerFor(m.sessionId)
        if (!r) return console.warn(`[agent] prompt untuk session tak dikenal ${m.sessionId}`)
        // Cold → hangat: proses baru di-spawn di sini, lalu resume percakapan.
        // Floor seq wajib diangkat dulu, kalau tidak frame pertama memakai
        // seq 1 yang sudah lama terpakai dan hub akan membuangnya diam-diam.
        r.outbox.raiseFloor(coldFloor[m.sessionId] ?? 0)
        r.prompt(m.text)
        break
      }

      case 'interrupt':
        void runners.get(m.sessionId)?.interrupt()
        break

      case 'approval_resp':
        runners.get(m.sessionId)?.resolveApproval(m.reqId, m.decision)
        break

      case 'close_session': {
        runners.get(m.sessionId)?.stop()
        runners.delete(m.sessionId)
        store.remove(m.sessionId)
        break
      }

      case 'ack':
        runners.get(m.sessionId)?.outbox.ackUpTo(m.seq)
        break

      case 'set_model': {
        const entry = store.get(m.sessionId)
        if (entry) store.put(m.sessionId, { ...entry, model: m.model })
        void runners.get(m.sessionId)?.setModel(m.model)
        break
      }

      case 'set_auto': {
        const entry = store.get(m.sessionId)
        if (entry) store.put(m.sessionId, { ...entry, auto: m.auto })
        const r = runners.get(m.sessionId)
        if (r) r.auto = m.auto
        break
      }

      case 'browse':
        // Hub sudah memastikan peminta adalah owner host ini.
        send({ t: 'browse_result', reqId: m.reqId, result: browse(m.path) })
        break
    }
  })

  /**
   * Handshake yang ditolak hub TIDAK memberi WS close code — statusnya HTTP,
   * dan `close` cuma melaporkan 1006. Tanpa cabang ini, token mati membuat
   * agent reconnect selamanya sambil mencetak "401" tanpa pernah menyebut apa
   * yang harus dilakukan.
   */
  ws.on('unexpected-response', (_req, res) => {
    if (res.statusCode !== 401 && res.statusCode !== 403) return
    const src = process.env.HOST_TOKEN
      ? 'HOST_TOKEN dari environment/.env'
      : `config di ${config.DIR}/config.json`
    console.error(`\n[agent] Hub menolak token host (HTTP ${res.statusCode}).`)
    console.error(`        Token dibaca dari: ${src}`)
    console.error('        Pasangkan ulang:   company-agent login')
    console.error('        (atau perbarui HOST_TOKEN kalau memang pakai jalur dev)\n')
    process.exit(1)
  })

  ws.on('close', (code) => {
    ws = null

    // Berhenti total, jangan reconnect. Tanpa ini dua agent dengan host token
    // yang sama akan saling menendang tanpa henti, dan gejalanya menyesatkan:
    // session tampak hidup tapi seq-nya bertabrakan sehingga hub membuang
    // frame sebagai duplikat — session diam total tanpa satu pun error.
    if (code === CLOSE.TOO_MANY) {
      console.error('\n[agent] host ini sudah dipegang koneksi lain. Berhenti.')
      console.error('        Pastikan hanya satu `company-agent start` per laptop.\n')
      process.exit(1)
    }
    if (code === CLOSE.BAD_TOKEN || code === CLOSE.FORBIDDEN) {
      console.error('\n[agent] token host ditolak. Jalankan: company-agent login\n')
      process.exit(1)
    }
    if (code === CLOSE.BAD_VERSION) {
      console.error('\n[agent] versi protokol tidak cocok dengan hub. Perbarui agent.\n')
      process.exit(1)
    }

    const wait = Math.min(backoff, 30_000) + Math.random() * 500 // jitter
    console.log(`[agent] terputus, reconnect dalam ${Math.round(wait / 1000)}s`)
    setTimeout(connect, wait)
    backoff = Math.min(backoff * 2, 30_000)
  })
  ws.on('error', (e) => console.error('[agent] ws error:', (e as Error).message))
}

/**
 * Agent ini menampung banyak session sekaligus. Satu rejection tak tertangkap
 * dari dalam SDK — misalnya menulis ke stdin proses yang gagal spawn — akan
 * mematikan proses dan menjatuhkan SEMUA session di laptop ini. Lebih baik
 * catat lalu jalan terus; session yang rusak sudah melaporkan error-nya
 * sendiri lewat frame.
 */
process.on('unhandledRejection', (err) => {
  console.error('[agent] rejection tak tertangkap:', (err as Error)?.message ?? err)
})

process.on('SIGINT', () => {
  console.log('\n[agent] berhenti')
  for (const r of runners.values()) r.stop()
  process.exit(0)
})

// ---------------------------------------------------------------------- cli

const cmd = process.argv[2] ?? 'start'

if (cmd === 'login') {
  login(HUB_HTTP, HUB).catch((e) => {
    console.error(`\n  Gagal: ${e.message}\n`)
    process.exit(1)
  })
} else if (cmd === 'logout') {
  config.clear()
  console.log('Token host dihapus. Session lokal tetap ada; `login` lagi untuk menyambung.')
} else if (cmd === 'start') {
  if (!TOKEN) {
    console.error('Belum dipasangkan. Jalankan: company-agent login')
    process.exit(1)
  }
  // HOST_TOKEN diam-diam mengalahkan hasil pairing. Kalau keduanya ada dan
  // berbeda, `login` akan tampak tidak berpengaruh sama sekali.
  if (process.env.HOST_TOKEN && cfg?.hostToken && process.env.HOST_TOKEN !== cfg.hostToken) {
    console.warn('[agent] HOST_TOKEN dari environment dipakai, mengabaikan hasil pairing.')
    console.warn(`        Hapus HOST_TOKEN dari .env untuk memakai ${config.DIR}/config.json`)
  }
  connect()
} else {
  console.error(`Perintah tidak dikenal: ${cmd}\nPakai: company-agent [login|start|logout]`)
  process.exit(1)
}
