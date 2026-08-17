/**
 * Wire protocol v1 — kontrak antara agent, hub, dan web.
 * Spesifikasi lengkap + rasionalnya: docs/PROTOCOL.md
 */

export const PROTOCOL_VERSION = 1

export const CLOSE = {
  BAD_TOKEN: 4401,
  FORBIDDEN: 4403,
  BAD_VERSION: 4426,
  TOO_MANY: 4429,
} as const

// ---------------------------------------------------------------- event stream

export type SessionStatus =
  | 'idle'
  | 'thinking'
  | 'waiting' // menunggu approval owner
  | 'ratelimited'
  | 'error'
  | 'offline' // host tidak terhubung; hanya diturunkan hub, bukan dari agent

export type Decision = 'allow' | 'deny' | 'allow_always'

// ------------------------------------------------------- pertanyaan balik

/**
 * Tool bawaan Claude Code untuk bertanya balik ke user. Ia lewat jalur
 * approval yang sama dengan tool lain, tapi "allow" saja tidak cukup: input
 * yang dikembalikan harus SUDAH berisi `answers`, karena itulah satu-satunya
 * tempat jawaban user masuk ke percakapan.
 */
export const ASK_TOOL = 'AskUserQuestion'

export type AskOption = { label: string; description: string }

export type AskQuestion = {
  question: string
  /** Label pendek untuk chip/tab. */
  header: string
  options: AskOption[]
  multiSelect?: boolean
}

/** `question` → jawaban. Multi-select digabung dengan koma. Bentuk ini milik
 * Claude Code, bukan pilihan kita — lihat docs/PROTOCOL.md §2. */
export type Answers = Record<string, string>

/**
 * Baca input tool sebagai daftar pertanyaan. Mengembalikan null kalau ini
 * bukan AskUserQuestion atau bentuknya tidak dikenal — UI lalu jatuh ke
 * tampilan approval biasa alih-alih meledak.
 */
export function askQuestions(name: string, input: unknown): AskQuestion[] | null {
  if (name !== ASK_TOOL) return null
  const qs = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(qs) || qs.length === 0) return null
  const out: AskQuestion[] = []
  for (const q of qs) {
    if (typeof q?.question !== 'string' || !Array.isArray(q?.options)) return null
    out.push({
      question: q.question,
      header: typeof q.header === 'string' ? q.header : '',
      options: q.options.filter(
        (o: unknown): o is AskOption => typeof (o as AskOption)?.label === 'string',
      ),
      multiSelect: q.multiSelect === true,
    })
  }
  return out
}

// ------------------------------------------------------------ sebutan @node

/** `@all` menyasar semua node milik user yang sedang online. */
export const MENTION_ALL = 'all'

/** Bentuk yang dikenali: `@nama`, atau `@nama:/path/ke/project`. */
const MENTION_RE = /@([A-Za-z0-9][A-Za-z0-9._-]*)(?::([^\s]+))?/g

export type Mention = {
  /** Teks utuh yang dicocokkan, termasuk `@`. */
  raw: string
  name: string
  /** Direktori kerja yang diminta, atau null kalau tidak disebut. */
  cwd: string | null
  index: number
}

/**
 * Nama node dinormalisasi sebelum dibandingkan: hostname asli sering memuat
 * spasi dan kapital (`Savana ThinkPad`) yang tidak mungkin diketik setelah `@`.
 */
export function nodeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function parseMentions(text: string): Mention[] {
  const out: Mention[] = []
  for (const m of text.matchAll(MENTION_RE)) {
    out.push({ raw: m[0], name: m[1]!, cwd: m[2] ?? null, index: m.index ?? 0 })
  }
  return out
}

/**
 * Buang sebutan yang benar-benar dipakai untuk routing dari teks prompt.
 * Yang tidak cocok dengan node mana pun sengaja DIBIARKAN — bisa jadi itu
 * memang bagian dari kalimat (`email @gmail`), bukan alamat node.
 */
export function stripMentions(text: string, used: Mention[]): string {
  if (!used.length) return text.trim()
  const drop = new Set(used.map((m) => m.index))
  let out = ''
  let cursor = 0
  for (const m of used.filter((x) => drop.has(x.index)).sort((a, b) => a.index - b.index)) {
    out += text.slice(cursor, m.index)
    cursor = m.index + m.raw.length
  }
  out += text.slice(cursor)
  return out.replace(/[ \t]{2,}/g, ' ').trim()
}

export type Usage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

// ------------------------------------------------------------- lampiran

/**
 * Tipe file yang didukung sebagai lampiran prompt — keduanya native di API
 * Claude (vision untuk gambar, dokumen untuk PDF), jadi tidak perlu jalur
 * ekstraksi teks sendiri. Tipe lain (kode, .txt, dst) belum didukung.
 */
export const ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
] as const

export type AttachmentMime = (typeof ATTACHMENT_MIME_TYPES)[number]

/** Batas per lampiran SEBELUM di-encode base64 (base64 ~4/3 lebih besar). */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_PROMPT = 4

/**
 * Lampiran sungguhan, byte-nya ikut — perjalanan browser → hub → agent SAJA.
 * Tidak pernah disimpan permanen (lihat AttachmentMeta) dan tidak pernah
 * dikirim balik ke browser lewat jalur lain.
 */
export type Attachment = {
  name: string
  mime: string
  dataBase64: string
}

/**
 * Jejak sebuah lampiran di transcript — nama & tipe saja, TANPA byte-nya.
 * Inilah yang disimpan permanen di DB hub dan dikirim ke browser sebagai
 * bagian dari Message; byte aslinya cuma hidup sesaat untuk giliran itu.
 */
export type AttachmentMeta = { name: string; mime: string }

/**
 * Validasi lampiran sebelum dikirim/diteruskan. Dipakai DUA kali — browser
 * (supaya user tahu sebelum submit) dan hub (supaya klien nakal atau web versi
 * lama tidak bisa menyelundupkan lampiran raksasa/tipe aneh ke agent). Satu
 * implementasi di sini biar batasnya tidak pernah beda antara keduanya.
 */
export function validateAttachments(attachments: Attachment[] | undefined): string | null {
  if (!attachments || !attachments.length) return null
  if (attachments.length > MAX_ATTACHMENTS_PER_PROMPT) {
    return `maksimal ${MAX_ATTACHMENTS_PER_PROMPT} lampiran per prompt`
  }
  for (const a of attachments) {
    if (!(ATTACHMENT_MIME_TYPES as readonly string[]).includes(a.mime)) {
      return `tipe file tidak didukung: ${a.name || a.mime}`
    }
    // base64 ~4/3 dari ukuran biner asli; dibalik untuk estimasi ukuran asli.
    const approxBytes = (a.dataBase64.length * 3) / 4
    if (approxBytes > MAX_ATTACHMENT_BYTES) {
      return `${a.name} kelebihan ukuran (maks ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB)`
    }
  }
  return null
}

export type Ev =
  /**
   * Prompt user, di-echo balik OLEH AGENT (bukan ditulis hub langsung).
   * Kelihatan memutar, tapi ini yang menjaga `seq` punya satu otoritas
   * tunggal — kalau hub menyisipkan seq-nya sendiri, replay setelah
   * reconnect akan bertabrakan dengan seq milik agent.
   */
  | { t: 'user_msg'; text: string; attachments?: AttachmentMeta[] }
  | { t: 'turn_start' }
  | { t: 'text_delta'; blk: number; text: string }
  | { t: 'thinking_delta'; blk: number; text: string }
  | { t: 'tool_start'; blk: number; id: string; name: string }
  /** JSON parsial — belum valid. Jangan JSON.parse sampai `tool_done`. */
  | { t: 'tool_input'; blk: number; partial: string }
  | { t: 'tool_done'; blk: number; input: unknown }
  | { t: 'tool_result'; id: string; ok: boolean; content: unknown }
  | { t: 'turn_end'; stopReason: string }
  | { t: 'approval_req'; reqId: string; name: string; input: unknown }
  | { t: 'approval_done'; reqId: string; decision: Decision }
  | { t: 'result'; usage: Usage; costUsd: number; durationMs: number }
  | { t: 'status'; status: SessionStatus; detail?: string }
  | { t: 'error'; message: string; fatal: boolean }

export type Frame = {
  sessionId: string
  /** Per-session, monotonic, mulai 1. Di-assign AGENT — lihat PROTOCOL.md §1. */
  seq: number
  ts: number
  ev: Ev
}

// ------------------------------------------------------------- agent <-> hub

/** Model yang tersedia di host, hasil enumerasi dari Claude Code di sana. */
export type ModelInfo = { value: string; displayName: string; description: string }

/** Satu direktori di host, hasil dari penjelajahan. */
export type DirEntry = { name: string; path: string }

export type BrowseResult = {
  path: string
  /** Home dir host, dipakai UI sebagai titik awal. */
  home: string
  parent: string | null
  entries: DirEntry[]
  error?: string
}

/** Ringkasan session milik host, dipakai agent untuk rekonsiliasi saat hello. */
export type SessionSpec = {
  sessionId: string
  cwd: string
  title: string
  auto: boolean
  /** null = pakai default Claude Code, bukan model tertentu. */
  model: string | null
}

/**
 * Gateway LLM sebuah node: Claude Code di laptop itu diarahkan ke endpoint lain
 * (mis. OpenRouter) alih-alih memakai login Claude miliknya.
 *
 * `apiKey` HANYA bergerak satu arah — browser → hub → agent — dan tidak pernah
 * ikut dalam roster, snapshot, atau apa pun yang kembali ke browser. Hub
 * meneruskannya tanpa menyimpannya; yang tersimpan di DB hub cuma `baseUrl`,
 * karena itulah satu-satunya bagian yang perlu ditampilkan lagi nanti.
 */
export type Gateway = { baseUrl: string; apiKey: string }

export type HubToAgent =
  | {
      t: 'hello'
      hostId: string
      resumeFrom: Record<string, number>
      /**
       * SEMUA session milik host ini menurut hub. Agent memakai ini untuk
       * mengisi yang belum dia punya — `create_session` bisa hilang kalau
       * agent sedang offline saat session dibuat, dan tanpa rekonsiliasi
       * session itu mati permanen tanpa pesan apa pun.
       */
      sessions: SessionSpec[]
    }
  | { t: 'set_auto'; sessionId: string; auto: boolean }
  | { t: 'set_model'; sessionId: string; model: string | null }
  /** Pairing dicabut hub. Agent membuang config lalu berhenti. */
  | { t: 'revoked'; reason: string }
  | { t: 'browse'; reqId: string; path: string }
  | { t: 'create_session'; sessionId: string; cwd: string; title: string; auto: boolean }
  | { t: 'prompt'; sessionId: string; text: string; attachments?: Attachment[] }
  | { t: 'interrupt'; sessionId: string }
  /** `answers` hanya untuk `ASK_TOOL`; diabaikan untuk tool lain. */
  | { t: 'approval_resp'; sessionId: string; reqId: string; decision: Decision; answers?: Answers }
  | { t: 'close_session'; sessionId: string }
  /** Simpan gateway di laptop ini dan pakai untuk proses Claude Code berikutnya. */
  | { t: 'set_gateway'; baseUrl: string; apiKey: string }
  /** Kembali memakai login Claude lokal; kunci di laptop dihapus. */
  | { t: 'clear_gateway' }
  | { t: 'ack'; sessionId: string; seq: number }

export type AgentToHub =
  | { t: 'auth'; v: number; hostName: string; platform: string; agentVersion: string }
  | {
      t: 'session_state'
      sessionId: string
      alive: boolean
      claudeSessionId?: string
      cwd: string
    }
  | { t: 'frame'; frame: Frame }
  | { t: 'browse_result'; reqId: string; result: BrowseResult }
  | { t: 'models'; models: ModelInfo[] }
  /**
   * Keadaan gateway menurut laptop — `null` berarti kembali ke login Claude
   * lokal. Agent yang melapor, bukan hub yang mencatat saat mengirim perintah:
   * yang benar-benar menentukan adalah file di laptop, dan pesan `set_gateway`
   * bisa saja tidak sampai.
   */
  | { t: 'gateway'; baseUrl: string | null }

// ----------------------------------------------------------- browser <-> hub

export type BrowserToHub =
  | { t: 'subscribe'; sessionId: string }
  | { t: 'unsubscribe'; sessionId: string }
  | { t: 'prompt'; sessionId: string; text: string; attachments?: Attachment[] }
  | { t: 'interrupt'; sessionId: string }
  | { t: 'approve'; sessionId: string; reqId: string; decision: Decision; answers?: Answers }
  | { t: 'new_session'; hostId: string; cwd: string; title: string }
  /** Session lintas node. Tidak terikat host mana pun saat dibuat. */
  | { t: 'new_general'; title: string }
  /** Lihat isi direktori di host. Owner host saja. `path` kosong = home. */
  | { t: 'browse'; hostId: string; path: string }
  /** Auto-approve semua tool di session ini. Owner saja. */
  | { t: 'set_auto'; sessionId: string; auto: boolean }
  /** Ganti model. `null` = kembali ke default. Owner saja. */
  | { t: 'set_model'; sessionId: string; model: string | null }
  /** Cabut pairing sebuah laptop. Owner host saja. */
  | { t: 'unbind_host'; hostId: string }
  /** Arahkan Claude Code di node ini ke gateway lain. Owner host saja. */
  | { t: 'set_gateway'; hostId: string; baseUrl: string; apiKey: string }
  /** Kembalikan node ini ke login Claude lokalnya. Owner host saja. */
  | { t: 'clear_gateway'; hostId: string }
  /** Hapus session beserta transcript-nya. Owner session saja, permanen. */
  | { t: 'delete_session'; sessionId: string }

export type Visibility = 'private' | 'team' | 'public'

export type SessionMeta = {
  id: string
  title: string
  cwd: string
  hostId: string
  ownerId: string
  visibility: Visibility
  status: SessionStatus
  /** Tool dijalankan tanpa minta izin dulu. */
  auto: boolean
  model: string | null
  updatedAt: number
}

export type HostMeta = {
  id: string
  name: string
  platform: string
  online: boolean
  /** Pairing sudah dicabut; token mati dan laptop tidak bisa menyambung lagi. */
  revoked: boolean
  /** Kosong sampai agent selesai mengenumerasi (butuh Claude Code hidup). */
  models: ModelInfo[]
  /**
   * Base URL gateway kalau node ini tidak memakai login Claude lokalnya.
   * Kuncinya TIDAK ada di sini dan tidak pernah dikirim balik ke browser.
   */
  gateway: string | null
  /** Session biasa saja. Lane milik general session TIDAK ikut di sini. */
  sessions: SessionMeta[]
}

/**
 * Satu node yang ikut dalam sebuah general session. Di balik layar ini adalah
 * session biasa milik satu host — itulah kenapa `seq`, replay, dan transcript
 * tetap jalan seperti session lain. Yang baru cuma pengelompokannya.
 */
export type LaneMeta = {
  sessionId: string
  hostId: string
  hostName: string
  cwd: string
  online: boolean
  status: SessionStatus
}

/**
 * Session yang tidak terikat satu laptop. Prompt-nya dirutekan lewat sebutan
 * `@node`, dan satu prompt bisa jalan di beberapa node sekaligus.
 */
export type GeneralMeta = {
  id: string
  title: string
  ownerId: string
  updatedAt: number
  lanes: LaneMeta[]
}

export type UserMeta = {
  id: string
  name: string
  hosts: HostMeta[]
  /** Hanya milik user yang meminta roster — general session selalu privat. */
  generals: GeneralMeta[]
}

/** Satu blok konten dalam giliran assistant, sudah dirakit dari delta. */
export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  /** Kegagalan yang ikut tersimpan di transcript, bukan cuma status sesaat. */
  | { kind: 'error'; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      /** string saat masih streaming, unknown setelah tool_done */
      input: string | unknown
      done: boolean
      result?: { ok: boolean; content: unknown }
    }
  /**
   * Jejak lampiran yang dikirim user bersama prompt — nama & tipe saja.
   * Byte aslinya tidak pernah masuk sini (lihat AttachmentMeta); blok ini
   * murni supaya transcript tetap menunjukkan "pernah ada lampiran" setelah
   * reload, walau isinya sendiri sudah tidak tersimpan di mana pun.
   */
  | { kind: 'attachment'; name: string; mime: string }

export type Message = {
  id: string
  role: 'user' | 'assistant'
  blocks: Block[]
  ts: number
}

export type HubToBrowser =
  | { t: 'roster'; users: UserMeta[]; me: string }
  /**
   * Susunan lane sebuah general session. Dikirim saat subscribe dan setiap
   * kali ada node baru ikut. Isi tiap lane menyusul sebagai `snapshot` biasa
   * dengan `sessionId` lane — jadi jalur transcript-nya sama persis dengan
   * session biasa, tidak ada cabang khusus di browser.
   */
  | { t: 'general'; sessionId: string; title: string; lanes: LaneMeta[]; canPrompt: boolean }
  | {
      t: 'snapshot'
      sessionId: string
      messages: Message[]
      /** Giliran yang SEDANG berjalan — tanpa ini, late joiner kehilangan awalnya. */
      live: Message | null
      seq: number
      canPrompt: boolean
      auto: boolean
      model: string | null
      pendingApproval: { reqId: string; name: string; input: unknown } | null
    }
  | { t: 'frame'; frame: Frame }
  | { t: 'host_status'; hostId: string; online: boolean }
  /**
   * Session sudah dihapus. Dikirim ke SEMUA browser, bukan cuma yang menghapus:
   * pane yang terbuka di tab lain harus ikut tutup, kalau tidak ia menampilkan
   * transcript yang sudah tidak ada dan prompt ke sana hilang tanpa jejak.
   */
  | { t: 'session_gone'; sessionId: string }
  /**
   * General session (dan seluruh lane + transcript-nya) sudah dihapus.
   * Sama seperti `session_gone`, dikirim ke SEMUA browser: tab general ini
   * yang terbuka di browser lain harus ikut tutup, bukan cuma di sisi yang
   * menghapus.
   */
  | { t: 'general_gone'; generalId: string }
  | { t: 'browse_result'; hostId: string; result: BrowseResult }
  | { t: 'denied'; action: string; reason: string }

// ------------------------------------------------------------------- helpers

export function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/**
 * Merakit delta jadi blok. Dipakai DUA kali: di hub (buat live buffer supaya
 * late joiner dapat snapshot) dan di browser (buat render). Satu implementasi
 * biar keduanya tidak pernah beda hasil.
 */
export function applyEv(msg: Message, ev: Ev): void {
  switch (ev.t) {
    case 'text_delta':
      slot(msg, ev.blk, () => ({ kind: 'text', text: '' }), (b) => {
        if (b.kind === 'text') b.text += ev.text
      })
      break
    case 'thinking_delta':
      slot(msg, ev.blk, () => ({ kind: 'thinking', text: '' }), (b) => {
        if (b.kind === 'thinking') b.text += ev.text
      })
      break
    case 'tool_start':
      slot(
        msg,
        ev.blk,
        () => ({ kind: 'tool', id: ev.id, name: ev.name, input: '', done: false }),
        () => {},
      )
      break
    case 'tool_input':
      slot(msg, ev.blk, () => ({ kind: 'tool', id: '', name: '?', input: '', done: false }), (b) => {
        if (b.kind === 'tool' && typeof b.input === 'string') b.input += ev.partial
      })
      break
    case 'tool_done':
      slot(msg, ev.blk, () => ({ kind: 'tool', id: '', name: '?', input: '', done: false }), (b) => {
        if (b.kind === 'tool') {
          b.input = ev.input
          b.done = true
        }
      })
      break
    case 'error':
      // Tempel di akhir, jangan lewat `slot`: error tidak punya index blok
      // dari API — ia datang dari agent/SDK, di luar aliran konten model.
      msg.blocks.push({ kind: 'error', text: ev.message })
      break

    case 'tool_result': {
      const b = msg.blocks.find((x) => x.kind === 'tool' && x.id === ev.id)
      if (b && b.kind === 'tool') b.result = { ok: ev.ok, content: ev.content }
      break
    }
  }
}

function slot(
  msg: Message,
  idx: number,
  make: () => Block,
  mutate: (b: Block) => void,
): void {
  // Block bisa datang tidak berurutan; isi lubangnya supaya index tetap stabil.
  while (msg.blocks.length <= idx) msg.blocks.push({ kind: 'text', text: '' })
  if (!msg.blocks[idx]) msg.blocks[idx] = make()
  const cur = msg.blocks[idx]!
  // Slot placeholder kosong yang ternyata bukan text: ganti dengan bentuk asli.
  if (cur.kind === 'text' && cur.text === '' && make().kind !== 'text') {
    msg.blocks[idx] = make()
  }
  mutate(msg.blocks[idx]!)
}

export function emptyMessage(role: 'user' | 'assistant', id: string): Message {
  return { id, role, blocks: [], ts: Date.now() }
}
