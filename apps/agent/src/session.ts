import { query, type Query } from '@anthropic-ai/claude-agent-sdk'
import { ASK_TOOL, type Answers, type Decision, type Ev, type Frame } from '@company/protocol'
import { Outbox } from './outbox.ts'
import { checkCwd } from './fs.ts'
import { claudeSpawnOptions } from './claude.ts'

/** Session tanpa aktivitas selama ini akan dimatikan prosesnya (jadi "cold"). */
const IDLE_MS = Number(process.env.IDLE_MS ?? 10 * 60_000)

type Emit = (frame: Frame) => void

/** Balasan owner atas satu `approval_req`. `answers` hanya terisi untuk ASK_TOOL. */
type Verdict = { decision: Decision; answers?: Answers }

/**
 * Antrian prompt sebagai AsyncIterable. Inilah yang bikin satu proses Claude
 * Code tetap hidup lintas banyak prompt (streaming input mode) — bukan spawn
 * baru tiap kali user mengetik.
 */
class PromptQueue implements AsyncIterable<any> {
  private items: any[] = []
  private wake: (() => void) | null = null
  private closed = false

  push(text: string): void {
    this.items.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: '',
    })
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      if (this.items.length) {
        yield this.items.shift()
        continue
      }
      await new Promise<void>((r) => (this.wake = r))
      this.wake = null
    }
  }
}

export class SessionRunner {
  readonly outbox: Outbox
  private q: Query | null = null
  private queue = new PromptQueue()
  private approvals = new Map<string, (v: Verdict) => void>()
  private idleTimer: NodeJS.Timeout | null = null

  claudeSessionId: string | undefined
  /** Auto-approve: jalankan tool tanpa menunggu keputusan owner. */
  auto = false
  /** null = default Claude Code. */
  model: string | null = null

  /**
   * Index blok bersifat relatif per API message, tapi satu "giliran" di UI
   * mencakup banyak API message (assistant → tool → assistant → ...). Offset
   * ini menggeser index supaya blok tidak saling menimpa dalam satu giliran.
   */
  private blkBase = 0
  private maxRel = -1
  private toolJson = new Map<number, string>()

  readonly sessionId: string
  readonly cwd: string
  private readonly emit: Emit
  private readonly onClaudeSessionId: (sid: string) => void

  constructor(
    sessionId: string,
    cwd: string,
    claudeSessionId: string | undefined,
    emit: Emit,
    onClaudeSessionId: (sid: string) => void,
  ) {
    this.sessionId = sessionId
    this.cwd = cwd
    this.emit = emit
    this.onClaudeSessionId = onClaudeSessionId
    this.outbox = new Outbox(sessionId)
    this.claudeSessionId = claudeSessionId
  }

  get alive(): boolean {
    return this.q !== null
  }

  private send(ev: Ev): void {
    const frame = this.outbox.make(ev)
    if (process.env.DEBUG_EV) console.log(`  ev#${frame.seq} ${ev.t}`)
    this.emit(frame)
  }

  // ------------------------------------------------------------- lifecycle

  prompt(text: string): void {
    this.touch()
    this.send({ t: 'user_msg', text })
    this.send({ t: 'turn_start' })
    this.send({ t: 'status', status: 'thinking' })
    this.blkBase = 0
    this.maxRel = -1
    this.toolJson.clear()

    if (!this.q) this.start()
    this.queue.push(text)
  }

  /**
   * Ganti model. Kalau proses sedang hidup, dipindah saat itu juga lewat
   * control request; kalau cold, cukup disimpan dan dipakai saat start
   * berikutnya.
   */
  async setModel(model: string | null): Promise<void> {
    this.model = model
    try {
      await this.q?.setModel(model ?? undefined)
    } catch {
      /* proses tidak berjalan; akan terpakai saat start berikutnya */
    }
  }

  async interrupt(): Promise<void> {
    try {
      await this.q?.interrupt()
    } catch {
      /* sudah tidak berjalan */
    }
  }

  resolveApproval(reqId: string, decision: Decision, answers?: Answers): void {
    this.approvals.get(reqId)?.({ decision, answers })
    this.approvals.delete(reqId)
  }

  /** Matikan proses tapi pertahankan identitas session — bisa di-resume nanti. */
  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.queue.close()
    this.queue = new PromptQueue()
    this.q = null
    for (const resolve of this.approvals.values()) resolve({ decision: 'deny' })
    this.approvals.clear()
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.q) {
        console.log(`[agent] session ${this.sessionId.slice(0, 8)} idle → cold`)
        this.stop()
      }
    }, IDLE_MS)
    this.idleTimer.unref()
  }

  private start(): void {
    // Dicek DI SINI, sebelum spawn. Tanpa ini SDK gagal dengan "spawn node
    // ENOENT" — pesan yang menunjuk ke arah yang sepenuhnya salah — lalu
    // penulisan ke stdin yang sudah mati melempar rejection tak tertangkap
    // yang menjatuhkan SELURUH agent, bukan cuma session ini.
    const check = checkCwd(this.cwd)
    if (!check.ok) {
      this.send({ t: 'error', message: check.reason, fatal: true })
      this.send({ t: 'status', status: 'error', detail: check.reason })
      this.send({ t: 'turn_end', stopReason: 'error' })
      return
    }

    const q = query({
      prompt: this.queue,
      options: {
        cwd: check.path,
        ...claudeSpawnOptions(),
        ...(this.model ? { model: this.model } : {}),
        // Kalau ada, lanjutkan percakapan lama alih-alih mulai dari nol.
        ...(this.claudeSessionId ? { resume: this.claudeSessionId } : {}),
        includePartialMessages: true,
        permissionMode: 'default',
        canUseTool: async (name, input) => {
          // AskUserQuestion bukan soal izin, tapi soal jawaban: "allow" dengan
          // input apa adanya berarti `answers` kosong, dan Claude menerima
          // "User has answered your questions:" tanpa isi. Jadi tool ini SELALU
          // ditanyakan, bahkan saat auto mode — tidak ada jawaban yang bisa
          // ditebak agent.
          const asking = name === ASK_TOOL

          // Auto mode: langsung izinkan. Tetap terlihat di transcript lewat
          // tool_start/tool_result, jadi tidak ada eksekusi yang tersembunyi —
          // yang hilang hanya kesempatan menolaknya.
          if (this.auto && !asking) return { behavior: 'allow', updatedInput: input }

          const reqId = `ap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          this.send({ t: 'approval_req', reqId, name, input })
          this.send({ t: 'status', status: 'waiting' })

          const { decision, answers } = await new Promise<Verdict>((resolve) => {
            this.approvals.set(reqId, resolve)
          })

          this.send({ t: 'approval_done', reqId, decision })
          this.send({ t: 'status', status: 'thinking' })

          if (decision === 'deny') {
            return {
              behavior: 'deny',
              message: asking ? 'User tidak menjawab pertanyaan' : 'Ditolak owner lewat web',
            }
          }

          return {
            behavior: 'allow',
            updatedInput: asking
              ? { ...(input as Record<string, unknown>), answers: answers ?? {} }
              : input,
          }
        },
      },
    })

    this.q = q
    void this.pump(q)
  }

  // ------------------------------------------------------------ translation

  /**
   * Menerjemahkan output SDK ke event stream milik kita. Normalisasi terjadi
   * DI SINI supaya browser tidak pernah menyentuh struktur SDK — update SDK
   * tidak boleh bisa merusak frontend.
   */
  private async pump(q: Query): Promise<void> {
    try {
      for await (const m of q as AsyncIterable<any>) {
        if (m.session_id && m.session_id !== this.claudeSessionId) {
          this.claudeSessionId = m.session_id
          this.onClaudeSessionId(m.session_id)
        }

        if (m.type === 'stream_event') {
          this.onStreamEvent(m.event)
        } else if (m.type === 'user') {
          for (const c of m.message?.content ?? []) {
            if (c.type === 'tool_result') {
              this.send({
                t: 'tool_result',
                id: c.tool_use_id,
                ok: !c.is_error,
                content: c.content,
              })
            }
          }
        } else if (m.type === 'assistant' && m.error) {
          const rate = m.error === 'rate_limit'
          this.send({ t: 'status', status: rate ? 'ratelimited' : 'error', detail: m.error })
        } else if (m.type === 'result') {
          this.send({
            t: 'result',
            usage: {
              inputTokens: m.usage?.input_tokens ?? 0,
              outputTokens: m.usage?.output_tokens ?? 0,
              cacheReadTokens: m.usage?.cache_read_input_tokens ?? 0,
              cacheCreationTokens: m.usage?.cache_creation_input_tokens ?? 0,
            },
            costUsd: m.total_cost_usd ?? 0,
            durationMs: m.duration_ms ?? 0,
          })
          if (m.is_error) {
            this.send({
              t: 'error',
              message: (m.errors ?? []).join('; ') || m.subtype || 'error',
              fatal: false,
            })
          }
          // Satu giliran UI = satu siklus penuh prompt → result, bukan satu API
          // message. Kalau dipotong per API message, hasil tool tidak punya
          // giliran untuk ditempeli.
          this.send({ t: 'turn_end', stopReason: m.subtype ?? 'success' })
          this.send({ t: 'status', status: 'idle' })
        }
      }
    } catch (err) {
      this.send({ t: 'error', message: String((err as Error)?.message ?? err), fatal: true })
      this.send({ t: 'status', status: 'error' })
    } finally {
      if (this.q === q) this.q = null
    }
  }

  private onStreamEvent(e: any): void {
    switch (e?.type) {
      case 'content_block_start': {
        const idx = this.abs(e.index)
        if (e.content_block?.type === 'tool_use') {
          this.toolJson.set(idx, '')
          this.send({ t: 'tool_start', blk: idx, id: e.content_block.id, name: e.content_block.name })
        }
        break
      }

      case 'content_block_delta': {
        const idx = this.abs(e.index)
        const d = e.delta
        if (d?.type === 'text_delta') {
          this.send({ t: 'text_delta', blk: idx, text: d.text })
        } else if (d?.type === 'thinking_delta') {
          this.send({ t: 'thinking_delta', blk: idx, text: d.thinking })
        } else if (d?.type === 'input_json_delta') {
          this.toolJson.set(idx, (this.toolJson.get(idx) ?? '') + d.partial_json)
          this.send({ t: 'tool_input', blk: idx, partial: d.partial_json })
        }
        break
      }

      case 'content_block_stop': {
        const idx = this.abs(e.index)
        const raw = this.toolJson.get(idx)
        if (raw !== undefined) {
          // Baru DI SINI JSON-nya utuh. Sebelum ini isinya potongan seperti
          // `{"file_pa` — parse lebih awal pasti gagal.
          let input: unknown = {}
          try {
            input = raw.trim() ? JSON.parse(raw) : {}
          } catch {
            input = { _unparsed: raw }
          }
          this.send({ t: 'tool_done', blk: idx, input })
          this.toolJson.delete(idx)
        }
        break
      }

      case 'message_stop':
        this.blkBase += this.maxRel + 1
        this.maxRel = -1
        break
    }
  }

  private abs(rel: number): number {
    if (rel > this.maxRel) this.maxRel = rel
    return this.blkBase + rel
  }
}
