import {
  applyEv,
  emptyMessage,
  validateAttachments,
  type Answers,
  type Attachment,
  type BrowseResult,
  type Decision,
  type Frame,
  type GeneralMeta,
  type HubToBrowser,
  type LaneMeta,
  type Message,
  type ModelInfo,
  type SessionMeta,
  type UserMeta,
} from '@company/protocol'

import { HUB, HUB_HTTP } from './hub-url.ts'

/** Batas tab terbuka. Tiap tab satu subscription; lebih dari ini cuma jadi beban. */
export const MAX_TABS = 8

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

/**
 * General session di sisi browser cuma daftar lane + draft. Isi tiap lane
 * tetap `SessionView` biasa di `views` — jadi jalur frame, dedup seq, dan
 * render transcript persis sama dengan session biasa.
 */
export type GeneralView = {
  title: string
  lanes: LaneMeta[]
  canPrompt: boolean
  loaded: boolean
  draft: string
}

class Store {
  users = $state<UserMeta[]>([])
  me = $state('')
  connected = $state(false)
  /** Tab yang sedang terbuka, kiri ke kanan — semua tetap subscribed walau tidak sedang dilihat. */
  open = $state<string[]>([])
  /** Tab yang sedang ditampilkan di main. Null hanya kalau `open` kosong. */
  active = $state<string | null>(null)
  /**
   * Panel eksperimental yang lagi tampil di kanan — MENGGANTIKAN tab session
   * sementara (lihat +page.svelte), bukan bagian dari sistem tab/`open`.
   * Sengaja terpisah: ini bukan session, tidak ada subscribe/lifecycle hub
   * sama sekali, jadi tidak masuk akal dipaksakan ke mekanisme `focus()`.
   * `open`/`active` tetap utuh di baliknya — nutup panel ini kembali ke tab
   * yang sedang aktif sebelumnya, bukan hilang.
   */
  experimental = $state<'youtube-short' | null>(null)
  views = $state<Record<string, SessionView>>({})
  generalViews = $state<Record<string, GeneralView>>({})
  notice = $state<string | null>(null)
  /** Diisi kalau hub menolak token; halaman kembali ke layar masuk. */
  authError = $state<string | null>(null)
  /** Hasil penjelajahan direktori terakhir, untuk pemilih project directory. */
  browseResult = $state<BrowseResult | null>(null)
  browseBusy = $state(false)

  #ws: WebSocket | null = null
  #token = ''
  #backoff = 500
  /** Judul general yang baru diminta, menunggu id-nya muncul di roster. */
  #wantGeneral: string | null = null

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

  /** General session milikku, dari roster. Null kalau id ini session biasa. */
  generalMeta(id: string): GeneralMeta | null {
    for (const u of this.users) {
      const g = u.generals?.find((x) => x.id === id)
      if (g) return g
    }
    return null
  }

  isGeneral(id: string): boolean {
    return !!this.generalViews[id] || !!this.generalMeta(id)
  }

  generalView(id: string): GeneralView | null {
    return this.generalViews[id] ?? null
  }

  /** Nama node pemilik sebuah session biasa — label tab. Null untuk general. */
  hostNameOf(sessionId: string): string | null {
    const m = this.meta(sessionId)
    if (!m) return null
    for (const u of this.users) {
      for (const h of u.hosts) if (h.id === m.hostId) return h.name
    }
    return null
  }

  /** Semua node milikku — bahan untuk pelengkap `@` di composer. */
  get myHosts() {
    return this.users.find((u) => u.id === this.me)?.hosts.filter((h) => !h.revoked) ?? []
  }

  get myGenerals(): GeneralMeta[] {
    return this.users.find((u) => u.id === this.me)?.generals ?? []
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
    this.active = null
    this.experimental = null
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
      case 'roster': {
        this.users = m.users
        this.me = m.me
        if (this.#wantGeneral) {
          const fresh = this.myGenerals.find((g) => g.title === this.#wantGeneral)
          if (fresh) {
            this.#wantGeneral = null
            this.focus(fresh.id)
          }
        }
        break
      }

      case 'snapshot': {
        const draft = this.views[m.sessionId]?.draft ?? ''
        this.views[m.sessionId] = {
          messages: m.messages,
          live: m.live,
          seq: m.seq,
          canPrompt: m.canPrompt,
          pending: m.pendingApproval,
          // Default eksplisit dengan alasan yang sama seperti `modelsFor`:
          // hub versi lama tidak mengirim field ini sama sekali.
          auto: m.auto ?? false,
          model: m.model ?? null,
          loaded: true,
          draft,
        }
        break
      }

      case 'general': {
        const prev = this.generalViews[m.sessionId]
        this.generalViews[m.sessionId] = {
          title: m.title,
          lanes: m.lanes,
          canPrompt: m.canPrompt,
          loaded: true,
          draft: prev?.draft ?? '',
        }
        // Lane baru bisa muncul kapan saja (node disebut pertama kali di tengah
        // percakapan); snapshot-nya menyusul sendiri lewat pesan `snapshot`.
        for (const l of m.lanes) this.#ensureView(l.sessionId)
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

      case 'session_gone': {
        // Tutup tab-nya di mana pun ia terbuka — termasuk browser lain yang
        // tidak menekan tombol hapus. Roster berikutnya cuma membersihkan sidebar.
        this.open = this.open.filter((id) => id !== m.sessionId)
        delete this.views[m.sessionId]
        if (this.active === m.sessionId) this.active = this.open[0] ?? null
        break
      }

      case 'general_gone': {
        // Sama seperti session_gone, plus lane-lanenya: general yang sudah
        // dihapus membawa serta seluruh view lane, kalau tidak generalViews
        // menyimpan sisa yang tidak akan pernah dibuang GC (dan #prepare bisa
        // salah mengira general ini masih ada kalau id-nya dipakai lagi).
        const gv = this.generalViews[m.generalId]
        for (const l of gv?.lanes ?? []) delete this.views[l.sessionId]
        delete this.generalViews[m.generalId]
        this.open = this.open.filter((id) => id !== m.generalId)
        if (this.active === m.generalId) this.active = this.open[0] ?? null
        break
      }

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
        for (const a of ev.attachments ?? []) {
          msg.blocks.push({ kind: 'attachment', name: a.name, mime: a.mime })
        }
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

  /**
   * Buka sebagai tab (kalau belum) dan jadikan yang aktif — tab lain yang
   * sudah terbuka TETAP terbuka di belakang, seperti tab browser. Ini satu
   * jalur untuk "klik session di sidebar" maupun "pindah ke tab yang sudah
   * ada"; bedanya cuma pada `wasOpen`.
   */
  focus(sessionId: string): void {
    // Panel eksperimental (lihat `experimental` di atas) menggantikan tampilan
    // tab SEMENTARA, bukan mengganti `active` — tanpa baris ini, klik session
    // yang kebetulan sudah `active` dari sebelumnya (early return di bawah)
    // tidak akan pernah menutup panel itu, dan sesi yang dipilih user tetap
    // tidak terlihat.
    this.experimental = null
    if (this.active === sessionId) return
    const wasOpen = this.open.includes(sessionId)
    if (!wasOpen) {
      if (this.open.length >= MAX_TABS) {
        this.notice = `Maksimal ${MAX_TABS} tab terbuka — tutup salah satu dulu`
        setTimeout(() => (this.notice = null), 3000)
        return
      }
      this.open = [...this.open, sessionId]
    }
    this.active = sessionId
    this.#prepare(sessionId)
    if (!wasOpen) this.#send({ t: 'subscribe', sessionId })
  }

  /** Siapkan wadah render sebelum snapshot datang — general beda dari session. */
  #prepare(id: string): void {
    if (!this.isGeneral(id)) return this.#ensureView(id)
    if (this.generalViews[id]) return
    const meta = this.generalMeta(id)
    this.generalViews[id] = {
      title: meta?.title ?? 'General',
      lanes: meta?.lanes ?? [],
      canPrompt: meta?.ownerId === this.me,
      loaded: false,
      draft: '',
    }
    for (const l of meta?.lanes ?? []) this.#ensureView(l.sessionId)
  }

  /** Tutup satu tab. Kalau itu tab yang sedang dilihat, pindah ke tetangganya. */
  closePane(sessionId: string): void {
    const idx = this.open.indexOf(sessionId)
    if (idx === -1) return
    this.open = this.open.filter((id) => id !== sessionId)
    this.#send({ t: 'unsubscribe', sessionId })
    if (this.active === sessionId) {
      // Tab yang sekarang menempati posisi yang sama (dulu di kanan), atau
      // kalau ini yang terakhir, tab sebelumnya. Kosong kalau tidak ada lagi.
      this.active = this.open[idx] ?? this.open[idx - 1] ?? null
    }
  }

  // ------------------------------------------------------------------ aksi

  /**
   * `attachments` sudah base64 di sini — `attachments.ts` (dipakai dari
   * Pane.svelte/GeneralPane.svelte) yang membaca file dan meng-encode-nya.
   * Divalidasi lagi di sini (bukan cuma di composer) supaya `notice` konsisten
   * dari satu tempat; hub tetap menegakkan ulang batas yang sama karena
   * browser bukan batas kepercayaan.
   */
  prompt(sessionId: string, text: string, attachments?: Attachment[]): void {
    const reason = validateAttachments(attachments)
    if (reason) {
      this.notice = reason
      setTimeout(() => (this.notice = null), 4000)
      return
    }
    this.#send({ t: 'prompt', sessionId, text, attachments })
  }

  interrupt(sessionId: string): void {
    this.#send({ t: 'interrupt', sessionId })
  }

  /** `answers` hanya dipakai kalau yang minta izin adalah AskUserQuestion. */
  approve(sessionId: string, reqId: string, decision: Decision, answers?: Answers): void {
    this.#send({ t: 'approve', sessionId, reqId, decision, answers })
    // Optimistis: agent akan mengirim `approval_done`, tapi menunggu round-trip
    // membuat form pertanyaan tetap terlihat setelah diklik — seolah tidak
    // terkirim, dan owner mengirim jawaban dua kali.
    const v = this.views[sessionId]
    if (v?.pending?.reqId === reqId) v.pending = null
  }

  newSession(hostId: string, cwd: string, title: string): void {
    this.#send({ t: 'new_session', hostId, cwd, title })
  }

  /** Session lintas node. Node-nya baru ditentukan lewat `@sebutan` di prompt. */
  newGeneral(title: string): void {
    // Id-nya dibuat hub, jadi yang bisa kita pegang cuma judulnya; begitu
    // roster berikutnya datang, session itu langsung dibuka.
    this.#wantGeneral = title
    this.#send({ t: 'new_general', title })
  }

  /**
   * Daftar model host pemilik session ini (kosong kalau belum dienumerasi).
   *
   * `?? []` bukan basa-basi: hub dan web di-deploy terpisah, jadi hub versi
   * lama akan mengirim roster tanpa field ini. Field yang hilang harus jadi
   * fitur yang tidak muncul, bukan halaman yang mati.
   */
  modelsFor(sessionId: string): ModelInfo[] {
    const meta = this.meta(sessionId)
    if (!meta) return []
    for (const u of this.users) {
      for (const h of u.hosts) if (h.id === meta.hostId) return h.models ?? []
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

  /**
   * Hapus session beserta transcript-nya. Permanen.
   *
   * Pane-nya tidak ditutup di sini: hub mengirim `session_gone` ke semua
   * browser, dan menutup lokal duluan cuma membuat tab yang satu ini berbeda
   * dari tab lain kalau ternyata hub menolak permintaannya.
   */
  deleteSession(sessionId: string): void {
    this.#send({ t: 'delete_session', sessionId })
  }

  /**
   * Hapus general session beserta SELURUH lane & transcript-nya di semua
   * node. Permanen.
   *
   * Wire-nya sama persis dengan `deleteSession` — `delete_session` dengan id
   * general di `sessionId` — hub yang membedakan lewat id-nya sendiri (lihat
   * `handleGeneral` di apps/hub/src/index.ts). Method terpisah di sini murni
   * supaya jelas di titik panggil, bukan protokol baru.
   */
  deleteGeneral(generalId: string): void {
    this.#send({ t: 'delete_session', sessionId: generalId })
  }

  /** Cabut pairing sebuah laptop. Tidak bisa dibatalkan — harus pairing ulang. */
  unbindHost(hostId: string): void {
    this.#send({ t: 'unbind_host', hostId })
  }

  /**
   * Arahkan Claude Code di sebuah node ke gateway lain (mis. OpenRouter).
   *
   * Kuncinya lewat hub — hub meneruskan ke agent tanpa menyimpannya, dan yang
   * kembali ke browser cuma base URL-nya lewat roster. Tidak ada jalur untuk
   * membacanya lagi dari sini; mengganti berarti mengetik ulang.
   */
  setGateway(hostId: string, baseUrl: string, apiKey: string): void {
    this.#send({ t: 'set_gateway', hostId, baseUrl, apiKey })
  }

  /** Kembalikan node ke login Claude lokalnya; kunci di laptop dihapus. */
  clearGateway(hostId: string): void {
    this.#send({ t: 'clear_gateway', hostId })
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
