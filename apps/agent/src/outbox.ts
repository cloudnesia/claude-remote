import type { Ev, Frame } from '@company/protocol'

/**
 * Buffer frame keluar per session. Ini yang bikin transcript selamat saat
 * laptop sleep / ganti wifi: proses Claude Code lokal terus jalan meski WS ke
 * hub putus, frame-nya menumpuk di sini, lalu dikirim ulang saat reconnect.
 *
 * Buffer hanya dibuang saat hub meng-ack, dan hub sengaja hanya meng-ack di
 * batas giliran (PROTOCOL.md §3) — jadi ukurannya terikat pada panjang satu
 * giliran, bukan pada umur session.
 */
export class Outbox {
  private seq = 0
  private buf: Frame[] = []
  private sessionId: string

  // Field eksplisit, bukan parameter property: Node menjalankan .ts ini dengan
  // strip-only mode yang tidak menulis ulang sintaks apa pun.
  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  make(ev: Ev): Frame {
    const frame: Frame = { sessionId: this.sessionId, seq: ++this.seq, ts: Date.now(), ev }
    this.buf.push(frame)
    return frame
  }

  ackUpTo(seq: number): void {
    this.buf = this.buf.filter((f) => f.seq > seq)
  }

  /** Frame yang belum dilihat hub, untuk dikirim ulang setelah reconnect. */
  since(seq: number): Frame[] {
    return this.buf.filter((f) => f.seq > seq)
  }

  /**
   * Setelah agent restart, counter lokal balik ke 0 sementara hub sudah
   * melihat seq yang jauh lebih tinggi. Tanpa ini, frame baru akan memakai seq
   * yang sudah terpakai dan hub akan membuangnya sebagai duplikat — session
   * jadi diam total tanpa error.
   */
  raiseFloor(seq: number): void {
    if (seq > this.seq) this.seq = seq
  }

  get depth(): number {
    return this.buf.length
  }
}
