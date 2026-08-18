import {
  MENTION_ALL,
  nodeSlug,
  parseMentions,
  replaceMentions,
  type Mention,
} from '@company/protocol'
import type { HostRow } from './db.ts'

/**
 * Identitas node buat disisipkan ke teks prompt menggantikan `@sebutan`nya —
 * Claude yang menjawab harus tahu ia sungguhan berjalan di mesin mana, bukan
 * cuma melihat sebutan itu lenyap tanpa jejak. IP-nya self-report dari agent
 * (lihat auth.ip di protocol); null kalau agent belum melapor atau memang
 * tidak ketemu interface non-internal — fallback ke nama saja.
 */
function describeHost(h: HostRow): string {
  return h.ip ? `${h.name} (${h.ip})` : h.name
}

/**
 * Direktori kerja default sebuah lane. `~` sengaja dibiarkan mentah: yang tahu
 * home directory laptop itu cuma agent-nya (`expandPath` di apps/agent/src/fs.ts),
 * dan hub memang tidak pernah menebak-nebak isi filesystem host.
 */
export const DEFAULT_LANE_CWD = '~'

export type Target = { host: HostRow; cwd: string }

export type Routing = {
  targets: Target[]
  /** Sebutan yang tidak cocok dengan node mana pun. */
  unknown: string[]
  /** Node yang disebut tapi sedang offline — disebut terpisah supaya jelas. */
  offline: string[]
  /** Prompt tanpa sebutan routing. Inilah yang dikirim ke tiap node. */
  text: string
}

/**
 * Terjemahkan `@sebutan` jadi daftar node.
 *
 * Sebuah sebutan bisa cocok ke LEBIH DARI SATU host — nama laptop gampang
 * kembar, dan menolak yang ambigu cuma bikin prompt gagal tanpa jalan keluar.
 * Fan-out memang tujuan fitur ini, jadi semuanya dipakai.
 */
export function route(
  text: string,
  hosts: HostRow[],
  isOnline: (hostId: string) => boolean,
  /**
   * Direktori lane yang terakhir dipakai node ini di general yang sama.
   * Sebutan telanjang menempel ke sana, kalau tidak `@node:/path` sekali di
   * awal akan berumur satu prompt saja dan lanjutannya diam-diam pindah ke
   * home — percakapan yang sama tampak kehilangan ingatan.
   */
  lastCwd: (hostId: string) => string | null,
): Routing {
  const live = hosts.filter((h) => !h.revoked)
  const mentions = parseMentions(text)

  const targets = new Map<string, Target>()
  const used: Mention[] = []
  const unknown: string[] = []
  const offline = new Set<string>()
  // index sebutan → teks pengganti (nama+IP node). Dibangun bareng loop di
  // bawah karena resolusinya (host mana yang cocok) sudah dihitung di situ.
  const resolved = new Map<number, string>()

  const take = (host: HostRow, asked: string | null): void => {
    if (!isOnline(host.id)) return void offline.add(host.name)
    const cwd = asked ?? lastCwd(host.id) ?? DEFAULT_LANE_CWD
    // Kunci per (host, cwd): node yang sama di dua direktori = dua lane.
    targets.set(`${host.id} ${cwd}`, { host, cwd })
  }

  for (const m of mentions) {
    const slug = nodeSlug(m.name)
    const cwd = m.cwd?.trim() || null

    if (slug === MENTION_ALL) {
      used.push(m)
      const online = live.filter((h) => isOnline(h.id))
      resolved.set(
        m.index,
        online.length ? `semua node online (${online.map(describeHost).join(', ')})` : 'semua node',
      )
      for (const h of live) take(h, cwd)
      continue
    }

    // Cocokkan nama dulu; id dipakai sebagai jalan keluar saat nama kembar.
    const matched = live.filter(
      (h) => nodeSlug(h.name) === slug || h.id.startsWith(m.name.toLowerCase()),
    )
    if (!matched.length) {
      unknown.push(m.name)
      continue
    }
    used.push(m)
    // Biasanya satu host; kalau nama kembar (comment di atas fungsi ini),
    // sebutan yang sama sengaja menyasar semuanya jadi teksnya ikut menyebut
    // semuanya — bukan cuma salah satu yang seolah-olah "menang".
    resolved.set(m.index, matched.map(describeHost).join(', '))
    for (const h of matched) take(h, cwd)
  }

  return {
    targets: [...targets.values()],
    unknown,
    offline: [...offline],
    // Sebutan diganti identitas node sungguhan (nama+IP), bukan sekadar
    // dibuang — supaya Claude yang menjawab tahu ia berjalan di mesin mana,
    // dan (untuk prompt yang menyebut beberapa node) tahu juga node lain
    // yang ikut disasar. Teksnya SAMA untuk semua target dalam satu fan-out
    // ini — resolusi @sebutan tidak tergantung siapa penerimanya.
    text: replaceMentions(text, used, (m) => resolved.get(m.index) ?? ''),
  }
}
