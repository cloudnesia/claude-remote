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
import { route } from './general.ts'
import {
  dropSession,
  ingest,
  lastSeqOf,
  markHostOffline,
  markHostOnline,
  onAck,
  onStatusChange,
  snapshotOf,
  statusOf,
  subscribe,
} from './live.ts'

const PORT = Number(process.env.PORT ?? 8787)
// Bind ke 127.0.0.1 kalau ada reverse proxy di depan; default terbuka supaya
// pemasangan tanpa proxy tetap jalan.
const HOST = process.env.HOST ?? '0.0.0.0'
const HEARTBEAT_MS = 20_000

/**
 * Prefiks kalau hub dipasang di sub-path, mis. nginx `location /socket`.
 * nginx meneruskan URI apa adanya, jadi yang sampai ke sini `/socket/ws`,
 * bukan `/ws` — tanpa dikupas semua rute di bawah meleset dan koneksi WS
 * langsung diputus. Dikupas di satu tempat supaya rute tetap ditulis absolut.
 */
const BASE_PATH = (process.env.BASE_PATH ?? '').replace(/\/+$/, '')

function stripBase(pathname: string): string {
  if (!BASE_PATH) return pathname
  if (pathname === BASE_PATH) return '/'
  return pathname.startsWith(`${BASE_PATH}/`) ? pathname.slice(BASE_PATH.length) : pathname
}

// -------------------------------------------------------------- connections

type AgentConn = { ws: WebSocket; hostId: string; alive: boolean }
type BrowserConn = {
  ws: WebSocket
  userId: string
  unsubs: Map<string, () => void>
  /** generalId → (laneSessionId → unsub). Lane bisa bertambah selagi terbuka. */
  generals: Map<string, Map<string, () => void>>
}

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

// ------------------------------------------------------------ session/lane

function sendSnapshot(conn: BrowserConn, s: db.SessionRow): void {
  const snap = snapshotOf(s.id)
  sendBrowser(conn, {
    t: 'snapshot',
    sessionId: s.id,
    messages: db.messagesOf(s.id),
    live: snap.live,
    seq: snap.seq,
    canPrompt: db.canWrite(s, conn.userId) && isOnline(s.host_id),
    auto: !!s.auto,
    model: s.model,
    pendingApproval: snap.pendingApproval,
  })
}

/**
 * Kirim isi satu lane lalu ikat streamnya. Urutannya wajib begini — sama
 * seperti subscribe biasa: frame yang datang di sela-sela punya seq > snapshot,
 * dan browser membuang apa pun yang <= itu.
 */
function attachLane(conn: BrowserConn, generalId: string, lane: db.SessionRow): void {
  const lanes = conn.generals.get(generalId)
  if (!lanes || lanes.has(lane.id)) return
  sendSnapshot(conn, lane)
  lanes.set(
    lane.id,
    subscribe(lane.id, (frame) => sendBrowser(conn, { t: 'frame', frame })),
  )
}

function sendGeneral(conn: BrowserConn, g: db.GeneralRow): void {
  sendBrowser(conn, {
    t: 'general',
    sessionId: g.id,
    title: g.title,
    lanes: db.lanesMeta(g.id, statusOf, isOnline),
    canPrompt: g.owner_id === conn.userId,
  })
}

/** Node baru ikut: semua yang sedang membuka general ini harus tahu. */
function announceLane(generalId: string, lane: db.SessionRow): void {
  const g = db.generalById(generalId)
  if (!g) return
  for (const c of browsers) {
    if (!c.generals.has(generalId)) continue
    sendGeneral(c, g)
    attachLane(c, generalId, lane)
  }
}

/**
 * Cari lane untuk (general, host, cwd), bikin kalau belum ada.
 *
 * Lane adalah session biasa — itu yang membuat satu prompt lintas node tetap
 * memakai jalur seq/replay/transcript yang sudah ada, alih-alih menambah jalur
 * kedua yang harus dijaga sendiri.
 */
function ensureLane(g: db.GeneralRow, host: db.HostRow, cwd: string): db.SessionRow | null {
  const existing = db.laneAt(g.id, host.id, cwd)
  if (existing) return existing

  const id = randomUUID()
  db.createSession({
    id,
    host_id: host.id,
    owner_id: g.owner_id,
    title: `${g.title} @ ${host.name}`,
    cwd,
    visibility: 'private',
    general_id: g.id,
  })
  sendAgent(host.id, { t: 'create_session', sessionId: id, cwd, title: g.title, auto: false })

  const lane = db.sessionById(id)
  if (lane) announceLane(g.id, lane)
  return lane
}

// -------------------------------------------------------------------- http

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.WEB_ORIGIN ?? '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.writeHead(204).end()

  const path = stripBase((req.url ?? '/').split('?')[0])
  if (path === '/health') return res.writeHead(200).end('ok')

  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  try {
    // Browser tidak bisa melihat status HTTP dari handshake WS yang ditolak —
    // `onerror` kosong dan `onclose` selalu 1006. Endpoint ini yang membuat
    // web bisa membedakan "token mati" dari "hub sedang mati".
    if (req.method === 'GET' && path === '/me') {
      const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      const user = db.userByToken(auth)
      if (!user) return json(401, { ok: false, reason: 'token user tidak valid' })
      return json(200, { ok: true, id: user.id, name: user.name })
    }

    // --- device-code pairing (lihat apps/hub/src/pairing.ts) ---
    if (req.method === 'POST' && path === '/pair/start') {
      const b = await readJson(req)
      const hostName = String(b.hostName ?? '').slice(0, 64) || 'laptop'
      const platform = String(b.platform ?? '').slice(0, 32)
      return json(200, pairing.start(hostName, platform))
    }

    if (req.method === 'POST' && path === '/pair/poll') {
      const b = await readJson(req)
      return json(200, pairing.poll(String(b.pollToken ?? '')))
    }

    if (req.method === 'POST' && path === '/pair/claim') {
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
  const path = stripBase(url.pathname)

  if (path === '/agent') {
    const host = db.hostByToken(token)
    if (!host) return reject(socket, CLOSE.BAD_TOKEN)
    wssAgent.handleUpgrade(req, socket, head, (ws) => onAgent(ws, host))
  } else if (path === '/ws') {
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
        // Status yang dibekukan saat host putus harus dicairkan DI SINI, kalau
        // tidak session-nya tetap tampak offline sampai ada prompt berikutnya.
        markHostOnline(db.sessionIdsOfHost(host.id))
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

      case 'gateway': {
        db.setHostGateway(host.id, m.baseUrl)
        console.log(
          `[hub] host ${host.name} ${m.baseUrl ? `memakai gateway ${m.baseUrl}` : 'kembali ke login Claude lokal'}`,
        )
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
  const conn: BrowserConn = { ws, userId: user.id, unsubs: new Map(), generals: new Map() }
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

    if (m.t === 'set_gateway' || m.t === 'clear_gateway') {
      const host = db.hostById(m.hostId)
      if (!host || host.owner_id !== user.id) {
        return sendBrowser(conn, { t: 'denied', action: m.t, reason: 'bukan host milikmu' })
      }
      // Kunci tidak disimpan di mana pun di sini, jadi tidak ada yang bisa
      // dikirim menyusul saat laptop bangun. Perintah ini butuh agent hidup.
      if (!isOnline(host.id)) {
        return sendBrowser(conn, { t: 'denied', action: m.t, reason: 'host sedang offline' })
      }

      if (m.t === 'clear_gateway') {
        sendAgent(host.id, { t: 'clear_gateway' })
        return
      }

      const baseUrl = m.baseUrl.trim()
      if (!/^https?:\/\/[^\s]+$/i.test(baseUrl) || baseUrl.length > 300) {
        return sendBrowser(conn, { t: 'denied', action: m.t, reason: 'base URL tidak valid' })
      }
      if (!m.apiKey || m.apiKey.length > 500) {
        return sendBrowser(conn, { t: 'denied', action: m.t, reason: 'API key tidak valid' })
      }

      // Diteruskan apa adanya lalu dilupakan — tidak ditulis ke DB, tidak
      // di-log. Yang tersimpan menyusul hanya `baseUrl`, saat agent melapor.
      sendAgent(host.id, { t: 'set_gateway', baseUrl, apiKey: m.apiKey })
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

    if (m.t === 'new_general') {
      const id = randomUUID()
      db.createGeneral({ id, owner_id: user.id, title: m.title || 'General' })
      broadcastRoster()
      return
    }

    // General session dulu: id-nya hidup di tabel lain, jadi `sessionById` di
    // bawah akan gagal menemukannya dan pesan-pesannya hilang tanpa jejak.
    const g = db.generalById(m.sessionId)
    if (g) {
      if (g.owner_id !== user.id) {
        return sendBrowser(conn, { t: 'denied', action: m.t, reason: 'bukan session milikmu' })
      }
      handleGeneral(conn, g, m)
      return
    }

    const s = db.sessionById(m.sessionId)
    if (!s) return

    if (m.t === 'subscribe') {
      if (!db.canRead(s, user.id)) {
        return sendBrowser(conn, { t: 'denied', action: m.t, reason: 'session privat' })
      }
      conn.unsubs.get(m.sessionId)?.()
      sendSnapshot(conn, s)
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

    // Hapus sengaja diproses SEBELUM syarat host online: session yang laptopnya
    // sudah pensiun justru yang paling ingin dibersihkan, dan menuntut host
    // hidup membuatnya tidak pernah bisa dihapus sama sekali.
    if (m.t === 'delete_session') {
      // Lane general tidak dihapus satuan: ia tidak muncul di bawah node, dan
      // melepas satu lane meninggalkan general dengan riwayat setengah.
      if (s.general_id) {
        return sendBrowser(conn, {
          t: 'denied',
          action: m.t,
          reason: 'lane general tidak bisa dihapus satuan',
        })
      }

      // Agent memberhentikan prosesnya dan membuang registry lokalnya. Kalau
      // laptopnya offline pesan ini hilang — pemangkasannya menyusul saat
      // `hello` berikutnya, lewat daftar session yang dibawa hub.
      sendAgent(s.host_id, { t: 'close_session', sessionId: s.id })

      db.deleteSession(s.id)
      dropSession(s.id)
      const gone = db.pruneRevokedHost(s.host_id)

      for (const c of browsers) {
        c.unsubs.get(s.id)?.()
        c.unsubs.delete(s.id)
        sendBrowser(c, { t: 'session_gone', sessionId: s.id })
      }
      console.log(`[hub] session ${s.id.slice(0, 8)} dihapus${gone ? ', host ikut dibuang' : ''}`)
      broadcastRoster()
      return
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
          answers: m.answers,
        })
        break
    }
  })

  const bye = () => {
    for (const un of conn.unsubs.values()) un()
    for (const lanes of conn.generals.values()) for (const un of lanes.values()) un()
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

// ------------------------------------------------------ general session ops

/**
 * Pesan browser yang menyasar general session. Bedanya dengan session biasa
 * cuma satu: tidak ada satu agent pun di ujung sana. Prompt dirutekan lewat
 * sebutan `@node` dan bisa mendarat di beberapa laptop sekaligus.
 */
function handleGeneral(conn: BrowserConn, g: db.GeneralRow, m: BrowserToHub): void {
  switch (m.t) {
    case 'subscribe': {
      // Lepas ikatan lama dulu: subscribe ulang terjadi tiap kali browser
      // reconnect, dan lane yang terikat dua kali mengirim frame dobel.
      for (const un of conn.generals.get(g.id)?.values() ?? []) un()
      conn.generals.set(g.id, new Map())
      sendGeneral(conn, g)
      for (const lane of db.lanesOf(g.id)) attachLane(conn, g.id, lane)
      return
    }

    case 'unsubscribe': {
      for (const un of conn.generals.get(g.id)?.values() ?? []) un()
      conn.generals.delete(g.id)
      return
    }

    case 'prompt': {
      const r = route(m.text, db.hostsOf(g.owner_id), isOnline, (hostId) =>
        db.lastLaneCwd(g.id, hostId),
      )

      if (!r.targets.length) {
        const why = r.offline.length
          ? `node sedang offline: ${r.offline.join(', ')}`
          : r.unknown.length
            ? `node tidak dikenal: ${r.unknown.map((n) => `@${n}`).join(', ')}`
            : 'sebut dulu node-nya, misalnya @laptop atau @all'
        return sendBrowser(conn, { t: 'denied', action: 'prompt', reason: why })
      }
      if (!r.text) {
        return sendBrowser(conn, { t: 'denied', action: 'prompt', reason: 'prompt kosong' })
      }

      for (const { host, cwd } of r.targets) {
        const lane = ensureLane(g, host, cwd)
        if (lane) sendAgent(host.id, { t: 'prompt', sessionId: lane.id, text: r.text })
      }
      db.touchGeneral(g.id)

      // Yang dilewati tetap dilaporkan: prompt yang diam-diam cuma mendarat di
      // sebagian node lebih berbahaya daripada yang gagal terang-terangan.
      const skipped = [
        ...r.offline.map((n) => `${n} (offline)`),
        ...r.unknown.map((n) => `@${n} (tidak dikenal)`),
      ]
      if (skipped.length) {
        sendBrowser(conn, { t: 'denied', action: 'prompt', reason: `dilewati: ${skipped.join(', ')}` })
      }
      broadcastRoster()
      return
    }

    case 'interrupt': {
      for (const lane of db.lanesOf(g.id)) sendAgent(lane.host_id, { t: 'interrupt', sessionId: lane.id })
      return
    }
  }
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

server.listen(PORT, HOST, () => {
  console.log(`[hub] listening on ${HOST}:${PORT}  (ws ${BASE_PATH}/agent, ws ${BASE_PATH}/ws)`)
})
