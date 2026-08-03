import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  CLOSE,
  PROTOCOL_VERSION,
  safeParse,
  type AgentToHub,
  type BrowserToHub,
  type HubToAgent,
  type HubToBrowser,
} from '@company/protocol'
import * as db from './db.ts'
import * as pairing from './pairing.ts'
import {
  ingest,
  lastSeqOf,
  markHostOffline,
  onAck,
  onStatusChange,
  snapshotOf,
  statusOf,
  subscribe,
} from './live.ts'

const PORT = Number(process.env.PORT ?? 8787)
const HEARTBEAT_MS = 20_000

// -------------------------------------------------------------- connections

type AgentConn = { ws: WebSocket; hostId: string; alive: boolean }
type BrowserConn = { ws: WebSocket; userId: string; unsubs: Map<string, () => void> }

const agents = new Map<string, AgentConn>() // hostId -> conn
const browsers = new Set<BrowserConn>()

/** Permintaan browse yang sedang menunggu jawaban agent. */
const browseReqs = new Map<string, { conn: BrowserConn; timer: NodeJS.Timeout }>()

const isOnline = (hostId: string) => agents.has(hostId)

const sendAgent = (hostId: string, m: HubToAgent) => agents.get(hostId)?.ws.send(JSON.stringify(m))
const sendBrowser = (c: BrowserConn, m: HubToBrowser) => c.ws.send(JSON.stringify(m))

// Watermark durable naik → beri tahu agent supaya outbox-nya boleh dipangkas.
onAck((sessionId, seq) => {
  const s = db.sessionById(sessionId)
  if (s) sendAgent(s.host_id, { t: 'ack', sessionId, seq })
})

// Status berubah → segarkan badge di sidebar semua orang. Di-debounce karena
// satu giliran memicu beberapa transisi berurutan.
let rosterTimer: NodeJS.Timeout | null = null
onStatusChange(() => {
  if (rosterTimer) return
  rosterTimer = setTimeout(() => {
    rosterTimer = null
    broadcastRoster()
  }, 250)
})

function broadcastRoster(): void {
  for (const c of browsers) {
    sendBrowser(c, { t: 'roster', users: db.roster(c.userId, statusOf, isOnline), me: c.userId })
  }
}

function broadcastHostStatus(hostId: string, online: boolean): void {
  for (const c of browsers) sendBrowser(c, { t: 'host_status', hostId, online })
}

// -------------------------------------------------------------------- http

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.WEB_ORIGIN ?? '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.writeHead(204).end()
  if (req.url === '/health') return res.writeHead(200).end('ok')

  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  try {
    // Browser tidak bisa melihat status HTTP dari handshake WS yang ditolak —
    // `onerror` kosong dan `onclose` selalu 1006. Endpoint ini yang membuat
    // web bisa membedakan "token mati" dari "hub sedang mati".
    if (req.method === 'GET' && req.url === '/me') {
      const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      const user = db.userByToken(auth)
      if (!user) return json(401, { ok: false, reason: 'token user tidak valid' })
      return json(200, { ok: true, id: user.id, name: user.name })
    }

    // --- device-code pairing (lihat apps/hub/src/pairing.ts) ---
    if (req.method === 'POST' && req.url === '/pair/start') {
      const b = await readJson(req)
      const hostName = String(b.hostName ?? '').slice(0, 64) || 'laptop'
      const platform = String(b.platform ?? '').slice(0, 32)
      return json(200, pairing.start(hostName, platform))
    }

    if (req.method === 'POST' && req.url === '/pair/poll') {
      const b = await readJson(req)
      return json(200, pairing.poll(String(b.pollToken ?? '')))
    }

    if (req.method === 'POST' && req.url === '/pair/claim') {
      // Klaim WAJIB atas nama user yang sudah login: klaim itu yang mengikat
      // laptop ke sebuah akun, dan pemegang akun itu nanti bisa menjalankan
      // shell di laptop tersebut.
      const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      const user = db.userByToken(auth)
      if (!user) return json(401, { ok: false, reason: 'token user tidak valid' })

      const b = await readJson(req)
      const result = pairing.claim(user.id, String(b.code ?? ''))
      if (result.ok) broadcastRoster()
      return json(result.ok ? 200 : 400, result)
    }
  } catch (err) {
    return json(400, { ok: false, reason: String((err as Error).message) })
  }

  res.writeHead(404).end('not found')
})

async function readJson(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 8192) throw new Error('body terlalu besar')
    chunks.push(c as Buffer)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
}

const wssAgent = new WebSocketServer({ noServer: true })
const wssBrowser = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const token = url.searchParams.get('token') ?? ''

  if (url.pathname === '/agent') {
    const host = db.hostByToken(token)
    if (!host) return reject(socket, CLOSE.BAD_TOKEN)
    wssAgent.handleUpgrade(req, socket, head, (ws) => onAgent(ws, host))
  } else if (url.pathname === '/ws') {
    const user = db.userByToken(token)
    if (!user) return reject(socket, CLOSE.BAD_TOKEN)
    wssBrowser.handleUpgrade(req, socket, head, (ws) => onBrowser(ws, user))
  } else {
    socket.destroy()
  }
})

function reject(socket: import('node:stream').Duplex, code: number): void {
  socket.write(`HTTP/1.1 ${code === CLOSE.BAD_TOKEN ? 401 : 403} Unauthorized\r\n\r\n`)
  socket.destroy()
}

// ------------------------------------------------------------- agent socket

function onAgent(ws: WebSocket, host: db.HostRow): void {
  // Satu host = satu koneksi. Yang lama diputus supaya tidak ada dua agent
  // menulis ke session yang sama dengan seq yang saling bertabrakan.
  agents.get(host.id)?.ws.close(CLOSE.TOO_MANY, 'replaced')

  const conn: AgentConn = { ws, hostId: host.id, alive: true }
  agents.set(host.id, conn)
  ws.on('pong', () => (conn.alive = true))

  ws.on('message', (raw) => {
    const m = safeParse<AgentToHub>(String(raw))
    if (!m) return

    switch (m.t) {
      case 'auth': {
        if (m.v !== PROTOCOL_VERSION) return ws.close(CLOSE.BAD_VERSION, 'protocol mismatch')
        db.markHostSeen(host.id, m.hostName, m.platform)

        // resumeFrom = titik tertinggi yang hub sudah tahu, bukan sekadar yang
        // durable. Ini menangani dua arah kegagalan sekaligus: hub yang restart
        // (in-memory kosong, pakai acked_seq dari DB) dan agent yang restart
        // (agent kehilangan counter, pakai lastSeq hub untuk melanjutkannya).
        const durable = db.resumeMapFor(host.id)
        const resumeFrom: Record<string, number> = {}
        for (const [sid, acked] of Object.entries(durable)) {
          resumeFrom[sid] = Math.max(acked, lastSeqOf(sid))
        }

        // Kirim juga daftar session lengkap. Agent memakainya untuk mengisi
        // yang belum dia punya — `create_session` bisa hilang kalau agent
        // sedang offline saat session dibuat.
        sendAgent(host.id, {
          t: 'hello',
          hostId: host.id,
          resumeFrom,
          sessions: db.specsOfHost(host.id),
        })
        broadcastHostStatus(host.id, true)
        broadcastRoster()
        break
      }

      case 'session_state': {
        if (m.claudeSessionId) db.setClaudeSessionId(m.sessionId, m.claudeSessionId)
        break
      }

      case 'frame': {
        const s = db.sessionById(m.frame.sessionId)
        // Frame untuk session yang bukan milik host ini = agent nakal / basi.
        if (!s || s.host_id !== host.id) return
        ingest(m.frame)
        break
      }

      case 'models': {
        db.setHostModels(host.id, m.models)
        broadcastRoster()
        break
      }

      case 'browse_result': {
        const pending = browseReqs.get(m.reqId)
        if (!pending) return // sudah kedaluwarsa atau browser sudah pergi
        browseReqs.delete(m.reqId)
        clearTimeout(pending.timer)
        sendBrowser(pending.conn, { t: 'browse_result', hostId: host.id, result: m.result })
        break
      }
    }
  })

  const bye = () => {
    if (agents.get(host.id) !== conn) return // sudah digantikan koneksi baru
    agents.delete(host.id)
    markHostOffline(db.sessionIdsOfHost(host.id))
    broadcastHostStatus(host.id, false)
    broadcastRoster()
  }
  ws.on('close', bye)
  ws.on('error', bye)
}

// ----------------------------------------------------------- browser socket

function onBrowser(ws: WebSocket, user: db.UserRow): void {
  const conn: BrowserConn = { ws, userId: user.id, unsubs: new Map() }
  browsers.add(conn)

  sendBrowser(conn, { t: 'roster', users: db.roster(user.id, statusOf, isOnline), me: user.id })

  ws.on('message', (raw) => {
    const m = safeParse<BrowserToHub>(String(raw))
    if (!m) return

    if (m.t === 'browse') {
      const host = db.hostById(m.hostId)
      // Ini membuka daftar isi filesystem laptop. Owner saja, titik.
      if (!host || host.owner_id !== user.id) {
        return sendBrowser(conn, { t: 'denied', action: m.t, reason: 'bukan host milikmu' })
      }
      if (!isOnline(host.id)) {
        return sendBrowser(conn, { t: 'denied', action: m.t, reason: 'host sedang offline' })
      }
      const reqId = randomUUID()
      const timer = setTimeout(() => {
        browseReqs.delete(reqId)
        sendBrowser(conn, { t: 'denied', action: 'browse', reason: 'host tidak menjawab' })
      }, 10_000)
      browseReqs.set(reqId, { conn, timer })
      sendAgent(host.id, { t: 'browse', reqId, path: m.path })
      return
    }

    if (m.t === 'unbind_host') {
      const host = db.hostById(m.hostId)
      if (!host || host.owner_id !== user.id) {
        return sendBrowser(conn, { t: 'denied', action: m.t, reason: 'bukan host milikmu' })
      }

      // Beri tahu agent lebih dulu supaya ia membuang config-nya sendiri.
      // Ini kebersihan untuk kasus normal (pensiunkan mesin), BUKAN kontrol
      // keamanan — laptop yang hilang jelas bisa mengabaikannya. Yang
      // menentukan adalah token yang sudah mati di sisi hub.
      sendAgent(host.id, { t: 'revoked', reason: 'pairing dicabut dari web' })

      const { deleted } = db.revokeHost(host.id)
      const conn2 = agents.get(host.id)
      if (conn2) {
        agents.delete(host.id)
        setTimeout(() => conn2.ws.close(CLOSE.FORBIDDEN, 'revoked'), 200)
        markHostOffline(db.sessionIdsOfHost(host.id))
        broadcastHostStatus(host.id, false)
      }
      console.log(`[hub] host ${host.name} dicabut${deleted ? ' dan dihapus' : ''}`)
      broadcastRoster()
      return
    }

    if (m.t === 'new_session') {
      const host = db.hostById(m.hostId)
      if (!host || host.owner_id !== user.id) {
        return sendBrowser(conn, { t: 'denied', action: m.t, reason: 'bukan host milikmu' })
      }
      if (!isOnline(host.id)) {
        return sendBrowser(conn, { t: 'denied', action: m.t, reason: 'host sedang offline' })
      }
      const id = randomUUID()
      db.createSession({
        id,
        host_id: host.id,
        owner_id: user.id,
        title: m.title || 'Session baru',
        cwd: m.cwd,
        visibility: 'team',
      })
      sendAgent(host.id, {
        t: 'create_session',
        sessionId: id,
        cwd: m.cwd,
        title: m.title,
        auto: false,
      })
      broadcastRoster()
      return
    }

    const s = db.sessionById(m.sessionId)
    if (!s) return

    if (m.t === 'subscribe') {
      if (!db.canRead(s, user.id)) {
        return sendBrowser(conn, { t: 'denied', action: m.t, reason: 'session privat' })
      }
      conn.unsubs.get(m.sessionId)?.()
      const snap = snapshotOf(m.sessionId)
      sendBrowser(conn, {
        t: 'snapshot',
        sessionId: m.sessionId,
        messages: db.messagesOf(m.sessionId),
        live: snap.live,
        seq: snap.seq,
        canPrompt: db.canWrite(s, user.id) && isOnline(s.host_id),
        auto: !!s.auto,
        model: s.model,
        pendingApproval: snap.pendingApproval,
      })
      // Subscribe SETELAH snapshot dikirim: frame yang datang di sela-sela akan
      // punya seq > snap.seq, dan browser membuang apa pun yang <= itu.
      conn.unsubs.set(
        m.sessionId,
        subscribe(m.sessionId, (frame) => sendBrowser(conn, { t: 'frame', frame })),
      )
      return
    }

    if (m.t === 'unsubscribe') {
      conn.unsubs.get(m.sessionId)?.()
      conn.unsubs.delete(m.sessionId)
      return
    }

    // Sisanya menulis: owner saja. Ditegakkan DI SINI, bukan di UI.
    if (!db.canWrite(s, user.id)) {
      return sendBrowser(conn, { t: 'denied', action: m.t, reason: 'hanya owner yang bisa' })
    }
    if (!isOnline(s.host_id)) {
      return sendBrowser(conn, { t: 'denied', action: m.t, reason: 'host sedang offline' })
    }

    switch (m.t) {
      case 'prompt':
        sendAgent(s.host_id, { t: 'prompt', sessionId: s.id, text: m.text })
        break
      case 'interrupt':
        sendAgent(s.host_id, { t: 'interrupt', sessionId: s.id })
        break
      case 'set_auto':
        db.setAuto(s.id, m.auto)
        sendAgent(s.host_id, { t: 'set_auto', sessionId: s.id, auto: m.auto })
        broadcastRoster()
        break
      case 'set_model':
        db.setModel(s.id, m.model)
        sendAgent(s.host_id, { t: 'set_model', sessionId: s.id, model: m.model })
        broadcastRoster()
        break
      case 'approve':
        sendAgent(s.host_id, {
          t: 'approval_resp',
          sessionId: s.id,
          reqId: m.reqId,
          decision: m.decision,
        })
        break
    }
  })

  const bye = () => {
    for (const un of conn.unsubs.values()) un()
    for (const [reqId, p] of browseReqs) {
      if (p.conn !== conn) continue
      clearTimeout(p.timer)
      browseReqs.delete(reqId)
    }
    browsers.delete(conn)
  }
  ws.on('close', bye)
  ws.on('error', bye)
}

// --------------------------------------------------------------- heartbeat

setInterval(() => {
  for (const conn of agents.values()) {
    if (!conn.alive) {
      conn.ws.terminate() // 'close' handler yang menandai host offline
      continue
    }
    conn.alive = false
    conn.ws.ping()
  }
}, HEARTBEAT_MS).unref()

server.listen(PORT, () => {
  console.log(`[hub] listening on :${PORT}  (ws /agent, ws /ws)`)
})
