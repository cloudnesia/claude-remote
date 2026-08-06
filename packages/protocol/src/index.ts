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

export type Usage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export type Ev =
  /**
   * Prompt user, di-echo balik OLEH AGENT (bukan ditulis hub langsung).
   * Kelihatan memutar, tapi ini yang menjaga `seq` punya satu otoritas
   * tunggal — kalau hub menyisipkan seq-nya sendiri, replay setelah
   * reconnect akan bertabrakan dengan seq milik agent.
   */
  | { t: 'user_msg'; text: string }
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
  | { t: 'prompt'; sessionId: string; text: string }
  | { t: 'interrupt'; sessionId: string }
  /** `answers` hanya untuk `ASK_TOOL`; diabaikan untuk tool lain. */
  | { t: 'approval_resp'; sessionId: string; reqId: string; decision: Decision; answers?: Answers }
  | { t: 'close_session'; sessionId: string }
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

// ----------------------------------------------------------- browser <-> hub

export type BrowserToHub =
  | { t: 'subscribe'; sessionId: string }
  | { t: 'unsubscribe'; sessionId: string }
  | { t: 'prompt'; sessionId: string; text: string }
  | { t: 'interrupt'; sessionId: string }
  | { t: 'approve'; sessionId: string; reqId: string; decision: Decision; answers?: Answers }
  | { t: 'new_session'; hostId: string; cwd: string; title: string }
  /** Lihat isi direktori di host. Owner host saja. `path` kosong = home. */
  | { t: 'browse'; hostId: string; path: string }
  /** Auto-approve semua tool di session ini. Owner saja. */
  | { t: 'set_auto'; sessionId: string; auto: boolean }
  /** Ganti model. `null` = kembali ke default. Owner saja. */
  | { t: 'set_model'; sessionId: string; model: string | null }
  /** Cabut pairing sebuah laptop. Owner host saja. */
  | { t: 'unbind_host'; hostId: string }

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
  sessions: SessionMeta[]
}

export type UserMeta = {
  id: string
  name: string
  hosts: HostMeta[]
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

export type Message = {
  id: string
  role: 'user' | 'assistant'
  blocks: Block[]
  ts: number
}

export type HubToBrowser =
  | { t: 'roster'; users: UserMeta[]; me: string }
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
