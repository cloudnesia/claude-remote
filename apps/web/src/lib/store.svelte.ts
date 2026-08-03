import {
  applyEv,
  emptyMessage,
  type BrowseResult,
  type Decision,
  type Frame,
  type HubToBrowser,
  type Message,
  type SessionMeta,
  type UserMeta,
} from '@company/protocol'

const HUB = import.meta.env.VITE_HUB_URL ?? 'ws://localhost:8787'
const HUB_HTTP = HUB.replace(/^ws/, 'http')

/** Batas pane terbuka. Tiap pane satu subscription; lebih dari ini tak terbaca. */
export const MAX_PANES = 3

export type SessionView = {
  messages: Message[]
  live: Message | null
  seq: number
  canPrompt: boolean
  pending: { reqId: string; name: string; input: unknown } | null
  auto: boolean
  model: string | null
  loaded: boolean
  draft: string
}

class Store {
  users = $state<UserMeta[]>([])
  me = $state('')
  connected = $state(false)
  /** Session yang sedang terbuka, kiri ke kanan. */
  open = $state<string[]>([])
  views = $state<Record<string, SessionView>>({})
  notice = $state<string | null>(null)
  /** Diisi kalau hub menolak token; halaman kembali ke layar masuk. */
  authError = $state<string | null>(null)
  /** Hasil penjelajahan direktori terakhir, untuk pemilih project directory. */
  browseResult = $state<BrowseResult | null>(null)
  browseBusy = $state(false)

  #ws: WebSocket | null = null
  #token = ''
  #backoff = 500

  meta(sessionId: string): SessionMeta | null {
    for (const u of this.users) {
      for (const h of u.hosts) {
        const s = h.sessions.find((x) => x.id === sessionId)
        if (s) return s
      }
    }
    return null
  }

  view(sessionId: string): SessionView | null {
    return this.views[sessionId] ?? null
  }

  async connect(token: string): Promise<void> {
    this.#token = token
    this.authError = null
    // Verifikasi lewat HTTP dulu. Kalau langsung buka WS, token mati tidak
    // bisa dibedakan dari hub mati — keduanya cuma jadi error kosong.
    if (await this.#tokenDead()) return
    this.#open()
  }

  /** true kalau hub secara eksplisit menolak token. Hub mati → false. */
  async #tokenDead(): Promise<boolean> {
    try {
      const r = await fetch(`${HUB_HTTP}/me`, {
        headers: { authorization: `Bearer ${this.#token}` },
      })
      if (r.status === 401) {
        this.signOut('Token tidak berlaku lagi. Masuk lagi dengan token yang baru.')
        return true
      }
      return false
    } catch {
      return false // hub tidak bisa dihubungi; itu bukan salah token
    }
  }

  signOut(reason: string | null = null): void {
    this.#ws?.close()
    this.#ws = null
    this.#token = ''
    this.connected = false
    this.open = []
    this.views = {}
    this.users = []
    this.authError = reason
    localStorage.removeItem('token')
  }

  #open(): void {
    const ws = new WebSocket(`${HUB}/ws?token=${encodeURIComponent(this.#token)}`)
    this.#ws = ws

    ws.onopen = () => {
      this.connected = true
      this.#backoff = 500
      // Setelah reconnect, minta ulang snapshot SEMUA pane yang terbuka — apa
      // pun yang terjadi selama putus ikut terbawa di sana.
      for (const id of this.open) this.#send({ t: 'subscribe', sessionId: id })
    }

    ws.onclose = async () => {
      this.connected = false
      if (!this.#token) return // sudah sign out
      // Token bisa dicabut selagi kita jalan. Cek tiap kali putus, kalau tidak
      // kita akan reconnect selamanya tanpa pernah memberi tahu kenapa.
      if (await this.#tokenDead()) return
      setTimeout(() => this.#open(), this.#backoff)
      this.#backoff = Math.min(this.#backoff * 2, 10_000)
    }

    ws.onmessage = (e) => this.#handle(JSON.parse(e.data) as HubToBrowser)
  }

  #send(m: unknown): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(m))
  }

  #handle(m: HubToBrowser): void {
    switch (m.t) {
      case 'roster':
        this.users = m.users
        this.me = m.me
        break

      case 'snapshot': {
        const draft = this.views[m.sessionId]?.draft ?? ''
        this.views[m.sessionId] = {
          messages: m.messages,
          live: m.live,
          seq: m.seq,
          canPrompt: m.canPrompt,
          pending: m.pendingApproval,
          auto: m.auto,
          model: m.model,
          loaded: true,
          draft,
        }
        break
      }

      case 'frame':
        this.#frame(m.frame)
        break

      case 'host_status':
        for (const u of this.users) {
          for (const h of u.hosts) if (h.id === m.hostId) h.online = m.online
        }
        break

      case 'browse_result':
        this.browseBusy = false
        this.browseResult = m.result
        break

      case 'denied':
        if (m.action === 'browse') this.browseBusy = false
        this.notice = m.reason
        setTimeout(() => (this.notice = null), 4000)
        break
    }
  }

  #frame(f: Frame): void {
    const v = this.views[f.sessionId]
    if (!v) return
    // Frame yang sudah tercakup snapshot. Wajib ada: antara snapshot dikirim
    // dan subscribe aktif, sebagian frame bisa terkirim dua kali.
    if (f.seq <= v.seq) return
    v.seq = f.seq

    const ev = f.ev
    switch (ev.t) {
      case 'user_msg': {
        const msg = emptyMessage('user', `u_${f.seq}`)
        msg.blocks.push({ kind: 'text', text: ev.text })
        v.messages.push(msg)
        break
      }
      case 'turn_start':
        v.live = emptyMessage('assistant', `a_${f.seq}`)
        break
      case 'turn_end':
        if (v.live) v.messages.push(v.live)
        v.live = null
        break
      case 'approval_req':
        v.pending = { reqId: ev.reqId, name: ev.name, input: ev.input }
        break
      case 'approval_done':
        v.pending = null
        break
      default:
        // Mutasi in-place: Svelte hanya me-render ulang node teks yang berubah.
        // Kalau di sini malah bikin array baru tiap delta, transcript panjang
        // akan tersendat parah.
        if (v.live) applyEv(v.live, ev)
    }
  }

  // ------------------------------------------------------------------ pane

  #ensureView(sessionId: string): void {
    if (this.views[sessionId]) return
    this.views[sessionId] = {
      messages: [],
      live: null,
      seq: 0,
      canPrompt: false,
      pending: null,
      auto: false,
      model: null,
      loaded: false,
      draft: '',
    }
  }

  /** Buka sendirian, menutup pane lain. */
  focus(sessionId: string): void {
    if (this.open.length === 1 && this.open[0] === sessionId) return
    for (const id of this.open) {
      if (id !== sessionId) this.#send({ t: 'unsubscribe', sessionId: id })
    }
    const wasOpen = this.open.includes(sessionId)
    this.open = [sessionId]
    this.#ensureView(sessionId)
    if (!wasOpen) this.#send({ t: 'subscribe', sessionId })
  }

  /** Tambah sebagai pane baru di sebelah yang sudah ada. */
  addPane(sessionId: string): void {
    if (this.open.includes(sessionId)) return
    if (this.open.length >= MAX_PANES) {
      this.notice = `Maksimal ${MAX_PANES} pane terbuka`
      setTimeout(() => (this.notice = null), 3000)
      return
    }
    this.open = [...this.open, sessionId]
    this.#ensureView(sessionId)
    this.#send({ t: 'subscribe', sessionId })
  }

  closePane(sessionId: string): void {
    this.open = this.open.filter((id) => id !== sessionId)
    this.#send({ t: 'unsubscribe', sessionId })
  }

  // ------------------------------------------------------------------ aksi

  prompt(sessionId: string, text: string): void {
    this.#send({ t: 'prompt', sessionId, text })
  }

  interrupt(sessionId: string): void {
    this.#send({ t: 'interrupt', sessionId })
  }

  approve(sessionId: string, reqId: string, decision: Decision): void {
    this.#send({ t: 'approve', sessionId, reqId, decision })
  }

  newSession(hostId: string, cwd: string, title: string): void {
    this.#send({ t: 'new_session', hostId, cwd, title })
  }

  /** Daftar model host pemilik session ini (kosong kalau belum dienumerasi). */
  modelsFor(sessionId: string) {
    const meta = this.meta(sessionId)
    if (!meta) return []
    for (const u of this.users) {
      for (const h of u.hosts) if (h.id === meta.hostId) return h.models
    }
    return []
  }

  setModel(sessionId: string, model: string | null): void {
    const v = this.views[sessionId]
    if (v) v.model = model
    this.#send({ t: 'set_model', sessionId, model })
  }

  setAuto(sessionId: string, auto: boolean): void {
    const v = this.views[sessionId]
    if (v) v.auto = auto
    this.#send({ t: 'set_auto', sessionId, auto })
  }

  /** Minta daftar subdirektori di host. `path` kosong = home host. */
  browse(hostId: string, path: string): void {
    this.browseBusy = true
    this.#send({ t: 'browse', hostId, path })
  }

  /** Mengikat laptop yang menampilkan kode ini ke akun user yang sedang login. */
  async claimHost(code: string): Promise<{ ok: boolean; message: string }> {
    const r = await fetch(`${HUB_HTTP}/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify({ code }),
    })
    const b = (await r.json()) as { ok: boolean; hostName?: string; reason?: string }
    return b.ok
      ? { ok: true, message: `"${b.hostName}" terhubung.` }
      : { ok: false, message: b.reason ?? 'gagal' }
  }
}

export const store = new Store()
