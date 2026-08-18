import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  CLOSE,
  PROTOCOL_VERSION,
  safeParse,
  validateAttachments,
  type AgentToHub,
  type Attachment,
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
  onTurnEnd,
  snapshotOf,
  statusOf,
  subscribe,
} from './live.ts'

/**
 * Jaring pengaman terakhir. try/catch di onAgent()/onBrowser()/broadcastRoster()
 * menangkap hampir semua kasus nyata, tapi tidak ada cara menjamin SETIAP
 * jalur async/timer di masa depan ikut dibungkus. Tanpa ini, satu lubang yang
 * kelewat bikin systemd (Restart=always) merestart hub berulang-ulang untuk
 * SEMUA user tiap kali kondisi yang sama terulang — persis gejala "agent
 * konek, hello, lalu langsung terputus" berulang tanpa henti. Log lalu jalan
 * terus jauh lebih baik daripada crash-loop yang mematikan layanan bersama.
 */
process.on('uncaughtException', (err) => {
  console.error('[hub] uncaught exception (proses tetap jalan):', err)
})
process.on('unhandledRejection', (err) => {
  console.error('[hub] unhandled rejection (proses tetap jalan):', err)
})

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
    try {
      sendBrowser(c, { t: 'roster', users: db.roster(c.userId, statusOf, isOnline), me: c.userId })
    } catch (err) {
      // Dipanggil juga dari timer debounce di onStatusChange() — DI LUAR
      // try/catch per-pesan di onAgent/onBrowser. Tanpa penjaga di sini,
      // roster yang gagal dibangun untuk SATU user (data korup, dsb.) jadi
      // exception tak tertangkap yang menjatuhkan hub untuk semua orang.
      console.error(`[hub] gagal membangun roster untuk user ${c.userId}:`, err)
    }
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

// ------------------------------------------------------- rantai node berurutan

/**
 * "@a @b @c prompt" — dulu ketiganya dapat prompt yang sama SEKALIGUS
 * (paralel). Sekarang, kalau sebutannya eksplisit (bukan lewat `@all`),
 * mereka jalan BERGANTIAN sesuai urutan ketik: kirim ke node pertama, tunggu
 * gilirannya selesai, baru kirim ke berikutnya — dengan jawaban node
 * sebelumnya disisipkan sebagai konteks (lihat `stepText`). `@all` TIDAK
 * pernah lewat sini — itu tetap broadcast paralel murni (lihat pemanggilnya
 * di case 'prompt').
 */
type ChainStep = { host: db.HostRow; cwd: string }
type Chain = {
  generalId: string
  steps: ChainStep[]
  index: number
  originalText: string
  attachments?: Attachment[]
  /** Jawaban langkah sebelumnya, disisipkan sebagai konteks ke langkah
   * berikutnya — ini yang membuat "ambil isi file di @a, jadikan parameter
   * buat @b" bekerja tanpa hub perlu mengerti isi prompt-nya sama sekali. */
  priorOutput: string | null
}
const chains = new Map<string, Chain>() // key: generalId — satu rantai aktif per general

function stepText(chain: Chain): string {
  if (!chain.priorOutput) return chain.originalText
  const prev = chain.steps[chain.index - 1]!
  return `Hasil dari ${prev.host.name} (langkah sebelumnya dalam urutan ini):\n${chain.priorOutput}\n\n---\n\n${chain.originalText}`
}

function runChainStep(chain: Chain): void {
  const step = chain.steps[chain.index]
  const g = db.generalById(chain.generalId)
  if (!step || !g) return void chains.delete(chain.generalId)

  // Node gilirannya offline pas ditunggu — jangan macet selamanya menunggu
  // sesuatu yang tidak akan pernah datang.
  if (!isOnline(step.host.id)) {
    chains.delete(chain.generalId)
    for (const c of browsers) {
      if (c.generals.has(chain.generalId)) {
        sendBrowser(c, {
          t: 'denied',
          action: 'prompt',
          reason: `rantai berhenti — ${step.host.name} offline gantian gilirannya`,
        })
      }
    }
    return
  }

  const lane = ensureLane(g, step.host, step.cwd)
  if (!lane) return void chains.delete(chain.generalId)

  sendAgent(step.host.id, {
    t: 'prompt',
    sessionId: lane.id,
    text: stepText(chain),
    // Lampiran cuma ikut langkah pertama — mengulang byte yang sama ke tiap
    // node di rantai tidak berguna dan boros.
    attachments: chain.index === 0 ? chain.attachments : undefined,
  })
  db.touchGeneral(chain.generalId)
}

// Satu-satunya jalur yang menggerakkan rantai maju: dipicu tiap kali SATU
// giliran (session mana pun, general atau bukan) selesai. Bukan cuma
// turn_end sukses — juga error fatal di tengah giliran (lihat live.ts),
// supaya rantai tidak menunggu selamanya untuk sinyal yang tidak akan datang.
onTurnEnd(({ sessionId, ok, text }) => {
  const s = db.sessionById(sessionId)
  const generalId = s?.general_id
  if (!generalId) return
  const chain = chains.get(generalId)
  if (!chain) return
  const step = chain.steps[chain.index]
  // Pastikan frame ini memang milik LANGKAH SEKARANG di rantai ini — bukan
  // giliran lama/tidak terkait yang kebetulan session-nya sama.
  if (!step || s.host_id !== step.host.id || s.cwd !== step.cwd) return

  if (!ok) {
    chains.delete(generalId)
    for (const c of browsers) {
      if (c.generals.has(generalId)) {
        sendBrowser(c, {
          t: 'denied',
          action: 'prompt',
          reason: `rantai berhenti — giliran ${step.host.name} gagal`,
        })
      }
    }
    broadcastRoster()
    return
  }

  chain.priorOutput = text
  chain.index++
  if (chain.index >= chain.steps.length) {
    chains.delete(generalId)
    return
  }
  runChainStep(chain)
})

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
    // Satu proses hub melayani SEMUA koneksi (agent + browser sekaligus).
    // Tanpa try/catch di sini, satu pesan yang memicu exception — bug di
    // handler, data korup, apa pun — menjatuhkan hub untuk semua orang, lalu
    // systemd me-restart-nya (Restart=always) hanya untuk jatuh lagi begitu
    // pesan yang sama diulang: crash-loop yang dari sisi agent kelihatan
    // seperti "terputus, reconnect" tanpa henti.
    try {
    const m = safeParse<AgentToHub>(String(raw))
    if (!m) return

    switch (m.t) {
      case 'auth': {
        if (m.v !== PROTOCOL_VERSION) return ws.close(CLOSE.BAD_VERSION, 'protocol mismatch')
        db.markHostSeen(host.id, m.hostName, m.platform, m.ip ?? null)

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
    } catch (err) {
      console.error(`[hub] error memproses pesan dari agent ${host.name}:`, err)
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
    // Lihat catatan yang sama di onAgent(): satu proses hub melayani semua
    // koneksi, jadi satu pesan browser yang melempar exception tidak boleh
    // menjatuhkan hub untuk semua orang.
    try {
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

      // Tutup semua session milik host ini di sisi agent SEBELUM barisnya
      // dihapus dari DB — sama seperti alur delete_session satuan, cuma
      // sekarang untuk seluruh sesi node ini sekaligus.
      const sessionIds = db.sessionIdsOfHost(host.id)
      for (const sid of sessionIds) {
        sendAgent(host.id, { t: 'close_session', sessionId: sid })
        dropSession(sid)
      }

      const conn2 = agents.get(host.id)
      if (conn2) {
        agents.delete(host.id)
        setTimeout(() => conn2.ws.close(CLOSE.FORBIDDEN, 'revoked'), 200)
      }

      db.revokeHost(host.id)

      for (const c of browsers) {
        for (const sid of sessionIds) {
          c.unsubs.get(sid)?.()
          c.unsubs.delete(sid)
          sendBrowser(c, { t: 'session_gone', sessionId: sid })
        }
      }

      console.log(
        `[hub] host ${host.name} dilepas dan dihapus (${sessionIds.length} session ikut terhapus)`,
      )
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
      case 'prompt': {
        // Ditegakkan lagi di sini, bukan cuma di web: batas ukuran/tipe/jumlah
        // adalah kontrak wire, dan klien yang curang (atau web versi lama yang
        // belum tahu batas ini) tidak boleh bisa menyelundupkan lampiran
        // raksasa langsung ke proses agent.
        const reason = validateAttachments(m.attachments)
        if (reason) return sendBrowser(conn, { t: 'denied', action: 'prompt', reason })
        sendAgent(s.host_id, {
          t: 'prompt',
          sessionId: s.id,
          text: m.text,
          attachments: m.attachments,
        })
        break
      }
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
    } catch (err) {
      console.error(`[hub] error memproses pesan dari browser (user ${user.id}):`, err)
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
      const attachReason = validateAttachments(m.attachments)
      if (attachReason) return sendBrowser(conn, { t: 'denied', action: 'prompt', reason: attachReason })

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
      // Teks boleh kosong kalau ada lampiran — "@node" + foto tanpa kalimat
      // lain itu valid, sama seperti session biasa. Tanpa lampiran, teks
      // kosong (cuma sebutan doang) tidak ada yang bisa dikerjakan Claude.
      if (!r.text && !m.attachments?.length) {
        return sendBrowser(conn, { t: 'denied', action: 'prompt', reason: 'prompt kosong' })
      }

      // @a @b eksplisit (bukan @all) dengan lebih dari satu target: jalan
      // BERGANTIAN sesuai urutan ketik, bukan sekaligus — lihat blok rantai
      // node berurutan di atas (dekat ensureLane) untuk alasannya.
      if (!r.usedAll && r.targets.length > 1) {
        const steps = r.targets.map(({ host, cwd }) => ({ host, cwd }))
        // Lane SEMUA langkah dibikin sekarang (bukan menyusul tiap giliran)
        // supaya langsung kelihatan di node-strip web — cuma prompt-nya yang
        // menyusul gantian.
        for (const { host, cwd } of steps) ensureLane(g, host, cwd)
        chains.set(g.id, {
          generalId: g.id,
          steps,
          index: 0,
          originalText: r.text,
          attachments: m.attachments,
          priorOutput: null,
        })
        runChainStep(chains.get(g.id)!)
      } else {
        for (const { host, cwd } of r.targets) {
          const lane = ensureLane(g, host, cwd)
          if (lane) {
            sendAgent(host.id, {
              t: 'prompt',
              sessionId: lane.id,
              text: r.text,
              attachments: m.attachments,
            })
          }
        }
        db.touchGeneral(g.id)
      }

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
      // Stop juga menghentikan rantai — kalau tidak, giliran yang sedang
      // di-interrupt akan tetap memicu langkah berikutnya begitu turn_end
      // (atau error) sampai, seolah Stop tidak sungguhan berhenti.
      chains.delete(g.id)
      for (const lane of db.lanesOf(g.id)) sendAgent(lane.host_id, { t: 'interrupt', sessionId: lane.id })
      return
    }

    case 'delete_session': {
      chains.delete(g.id)
      // Sama seperti delete_session biasa: agent diberi tahu duluan supaya
      // proses tiap lane berhenti, lepas dari host-nya online atau tidak.
      for (const lane of db.lanesOf(g.id)) {
        sendAgent(lane.host_id, { t: 'close_session', sessionId: lane.id })
        dropSession(lane.id)
      }

      // Lepas subscription lane general ini di SEMUA browser (bukan cuma
      // conn ini) — kalau tidak, koneksi live.ts-nya nyangkut dan generalViews
      // di browser lain tetap merender lane yang barisnya sudah tidak ada.
      for (const c of browsers) {
        for (const un of c.generals.get(g.id)?.values() ?? []) un()
        c.generals.delete(g.id)
      }

      const { lanes } = db.deleteGeneral(g.id)

      for (const c of browsers) sendBrowser(c, { t: 'general_gone', generalId: g.id })

      console.log(`[hub] general ${g.id.slice(0, 8)} dihapus (${lanes.length} lane ikut terhapus)`)
      broadcastRoster()
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
