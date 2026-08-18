import {
  applyEv,
  emptyMessage,
  type Frame,
  type Message,
  type SessionStatus,
} from '@company/protocol'
import { ackSeq, persistMessage } from './db.ts'

/** Gabungan semua blok teks satu Message — dipakai buat menyalurkan hasil
 * satu langkah rantai node berurutan (general.ts) ke langkah berikutnya. */
function textOf(m: Message): string {
  return m.blocks
    .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
    .map((b) => b.text)
    .join('\n\n')
}

/** Jeda coalescing hub→browser. Lihat catatan di `enqueue()`. */
const FLUSH_MS = 60

type Subscriber = (frame: Frame) => void

type LiveSession = {
  /** Giliran yang sedang berjalan. Inilah yang dikirim ke late joiner. */
  live: Message | null
  status: SessionStatus
  pendingApproval: { reqId: string; name: string; input: unknown } | null
  lastSeq: number
  subs: Set<Subscriber>
  pending: Frame[]
  timer: NodeJS.Timeout | null
}

const sessions = new Map<string, LiveSession>()

/**
 * Dipanggil saat watermark durable naik, supaya agent boleh membuang frame
 * dari outbox-nya. Di-set oleh index.ts (live.ts tidak tahu soal koneksi).
 */
let notifyAck: (sessionId: string, seq: number) => void = () => {}
export const onAck = (fn: typeof notifyAck): void => {
  notifyAck = fn
}

function durable(sessionId: string, seq: number): void {
  ackSeq(sessionId, seq)
  notifyAck(sessionId, seq)
}

/**
 * Dipanggil hanya saat status BERUBAH, bukan tiap frame. Badge di sidebar
 * milik user yang tidak sedang membuka session itu tetap harus ikut hidup —
 * tapi kalau roster di-broadcast tiap delta, hub-nya yang mati.
 */
let notifyStatus: (sessionId: string) => void = () => {}
export const onStatusChange = (fn: typeof notifyStatus): void => {
  notifyStatus = fn
}

/**
 * Satu giliran life-cycle penuh: dari `turn_start` sampai selesai, sukses
 * ATAU gagal. Dipakai general.ts buat rantai node berurutan (§11 PROTOCOL.md)
 * — begitu langkah sekarang selesai, lanjut ke node berikutnya dengan hasil
 * langkah ini disisipkan sebagai konteks; kalau gagal, rantai berhenti.
 * Tidak peduli general session atau bukan — pemanggilnya yang menyaring.
 */
export type TurnOutcome = { sessionId: string; ok: boolean; text: string }
let notifyTurnEnd: (o: TurnOutcome) => void = () => {}
export const onTurnEnd = (fn: typeof notifyTurnEnd): void => {
  notifyTurnEnd = fn
}

function get(sessionId: string): LiveSession {
  let s = sessions.get(sessionId)
  if (!s) {
    s = {
      live: null,
      status: 'idle',
      pendingApproval: null,
      lastSeq: 0,
      subs: new Set(),
      pending: [],
      timer: null,
    }
    sessions.set(sessionId, s)
  }
  return s
}

export const statusOf = (sessionId: string): SessionStatus =>
  sessions.get(sessionId)?.status ?? 'idle'

/** Seq tertinggi yang pernah DILIHAT hub (durable maupun belum). */
export const lastSeqOf = (sessionId: string): number => sessions.get(sessionId)?.lastSeq ?? 0

export const snapshotOf = (sessionId: string) => {
  const s = get(sessionId)
  return { live: s.live, seq: s.lastSeq, pendingApproval: s.pendingApproval }
}

export function subscribe(sessionId: string, fn: Subscriber): () => void {
  const s = get(sessionId)
  s.subs.add(fn)
  return () => {
    s.subs.delete(fn)
  }
}

/**
 * Titik masuk semua frame dari agent. Melakukan tiga hal berurutan:
 * merawat live buffer, memutuskan apa yang durable, lalu fan-out.
 */
export function ingest(frame: Frame): void {
  const s = get(frame.sessionId)

  // Frame duplikat dari replay setelah reconnect — sudah pernah diproses.
  if (frame.seq <= s.lastSeq) return
  s.lastSeq = frame.seq

  const ev = frame.ev
  const statusBefore = s.status

  switch (ev.t) {
    case 'user_msg': {
      const m = emptyMessage('user', `u_${frame.seq}`)
      m.blocks.push({ kind: 'text', text: ev.text })
      // Byte lampiran sudah lewat sesaat sebelumnya (langsung agent → Claude);
      // yang menetap di transcript cuma jejaknya, lihat AttachmentMeta.
      for (const a of ev.attachments ?? []) {
        m.blocks.push({ kind: 'attachment', name: a.name, mime: a.mime })
      }
      m.ts = frame.ts
      persistMessage(frame.sessionId, frame.seq, m)
      durable(frame.sessionId, frame.seq)
      break
    }

    case 'turn_start':
      s.live = emptyMessage('assistant', `a_${frame.seq}`)
      s.live.ts = frame.ts
      s.status = 'thinking'
      break

    case 'turn_end': {
      const text = s.live ? textOf(s.live) : ''
      if (s.live) {
        persistMessage(frame.sessionId, frame.seq, s.live)
        s.live = null
      }
      s.status = 'idle'
      // Ack HANYA di batas giliran — lihat PROTOCOL.md §3. Meng-ack di tengah
      // giliran akan membuat reconnect menghasilkan transcript terpotong.
      durable(frame.sessionId, frame.seq)
      notifyTurnEnd({ sessionId: frame.sessionId, ok: ev.stopReason === 'success', text })
      break
    }

    case 'approval_req':
      s.pendingApproval = { reqId: ev.reqId, name: ev.name, input: ev.input }
      s.status = 'waiting'
      break

    case 'approval_done':
      s.pendingApproval = null
      s.status = 'thinking'
      break

    case 'status':
      s.status = ev.status
      break

    case 'error':
      s.status = 'error'
      // Ikut ditulis ke transcript supaya alasannya tetap terlihat nanti,
      // bukan hanya sebagai badge merah yang hilang saat reload.
      if (s.live) applyEv(s.live, ev)
      if (ev.fatal && s.live) {
        // Simpan yang sempat terkumpul; lebih baik giliran terpotong daripada hilang.
        const text = textOf(s.live)
        persistMessage(frame.sessionId, frame.seq, s.live)
        s.live = null
        durable(frame.sessionId, frame.seq)
        // Exception di tengah pump() agent TIDAK selalu diikuti `turn_end` —
        // tanpa notifikasi di sini, rantai node berurutan menunggu giliran
        // yang tidak akan pernah datang, macet permanen.
        notifyTurnEnd({ sessionId: frame.sessionId, ok: false, text })
      }
      break

    default:
      if (s.live) applyEv(s.live, ev)
  }

  if (s.status !== statusBefore) notifyStatus(frame.sessionId)
  enqueue(s, frame)
}

/**
 * Coalescing. Satu session dengan 10 viewer dan streaming per-token berarti
 * ribuan WS frame/detik kalau diteruskan mentah. Viewer tidak peduli menerima
 * 40 delta terpisah atau 1 delta gabungan, jadi kita gabung per FLUSH_MS.
 *
 * Yang digabung hanya delta teks yang berurutan pada blok yang sama; event
 * lain (tool, approval, turn boundary) lewat apa adanya supaya urutannya utuh.
 */
function enqueue(s: LiveSession, frame: Frame): void {
  const prev = s.pending.at(-1)
  const ev = frame.ev

  if (
    prev &&
    (ev.t === 'text_delta' || ev.t === 'thinking_delta') &&
    prev.ev.t === ev.t &&
    (prev.ev as { blk: number }).blk === ev.blk
  ) {
    ;(prev.ev as { text: string }).text += ev.text
    prev.seq = frame.seq
  } else {
    s.pending.push(frame)
  }

  // Batas giliran dan approval harus sampai segera — UI menunggu keduanya.
  const urgent =
    ev.t === 'turn_end' || ev.t === 'approval_req' || ev.t === 'error' || ev.t === 'result'

  if (urgent) {
    flush(s)
  } else if (!s.timer) {
    s.timer = setTimeout(() => flush(s), FLUSH_MS)
  }
}

function flush(s: LiveSession): void {
  if (s.timer) {
    clearTimeout(s.timer)
    s.timer = null
  }
  if (!s.pending.length) return
  const batch = s.pending
  s.pending = []
  for (const f of batch) for (const sub of s.subs) sub(f)
}

/**
 * Host tersambung lagi: cairkan status yang dibekukan `markHostOffline`.
 *
 * Tanpa ini status `offline` menetap di memori sampai agent kebetulan
 * mengirim `status` berikutnya — dan agent hanya mengirimnya saat ada prompt.
 * Akibatnya session yang host-nya sudah kembali tetap tampak offline, composer
 * tetap terkunci, dan satu-satunya jalan keluar adalah mem-prompt session yang
 * UI-nya sendiri bilang tidak bisa di-prompt.
 */
export function markHostOnline(sessionIds: string[]): void {
  for (const id of sessionIds) {
    const s = sessions.get(id)
    if (s?.status !== 'offline') continue
    // Buffer live yang masih terisi = giliran terpotong saat koneksi putus;
    // agent akan me-replay sisanya, jadi 'thinking' lebih jujur dari 'idle'.
    s.status = s.live ? 'thinking' : 'idle'
  }
}

/**
 * Session dihapus: buang seluruh jejaknya di memori.
 *
 * Bukan sekadar kebersihan — tanpa ini `lastSeq` lama tetap tinggi, dan
 * session baru yang kebetulan memakai id sama (agent yang me-replay outbox
 * lawas, misalnya) akan dibuang diam-diam oleh cek duplikat di `ingest`.
 */
export function dropSession(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  if (s.timer) clearTimeout(s.timer)
  s.subs.clear()
  sessions.delete(sessionId)
}

/** Host putus: bekukan session yang sedang jalan supaya UI tidak menggantung. */
export function markHostOffline(sessionIds: string[]): void {
  for (const id of sessionIds) {
    const s = sessions.get(id)
    if (!s) continue
    s.status = 'offline'
    s.pendingApproval = null
    // live buffer sengaja DIPERTAHANKAN: agent akan replay dari acked_seq saat
    // reconnect, dan ingest() membuang duplikatnya lewat cek lastSeq.
  }
}
