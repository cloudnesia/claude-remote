/**
 * Menerjemahkan (nama tool, input) jadi bentuk yang enak dibaca manusia.
 *
 * Sebelum ini transcript menampilkan input tool apa adanya sebagai JSON satu
 * baris — `{"command":"cd ~/bot && pm2 start ...","description":"..."}`. Yang
 * sebenarnya ingin dilihat orang cuma perintahnya; sisanya tanda baca. Untuk
 * tool tulis-file bahkan lebih buruk: seluruh isi file jadi satu baris panjang
 * dengan `\n` literal, praktis tidak terbaca.
 *
 * Tool yang tidak dikenal tetap jatuh ke JSON — tapi JSON yang di-indent, bukan
 * satu baris. Bentuk asing lebih baik ditampilkan apa adanya daripada dipaksa
 * masuk cetakan yang salah.
 */

export type ToolBody =
  /** Perintah shell; ditampilkan dengan prompt `$`. */
  | { kind: 'shell'; text: string }
  /** Isi berkas atau potongan kode. */
  | { kind: 'code'; text: string; lang: string | null }
  /** Penggantian teks: yang lama vs yang baru. */
  | { kind: 'diff'; before: string; after: string }
  | { kind: 'text'; text: string }
  | { kind: 'json'; text: string }
  | { kind: 'todo'; items: { text: string; status: string }[] }

export type ToolView = {
  /** Nama tool, apa adanya — tetap ditampilkan supaya tidak menyembunyikan apa pun. */
  name: string
  /** Sasaran utama: path, URL, atau pola. Inilah yang dibaca duluan. */
  target: string | null
  /** Keterangan satu baris dari model, kalau tool-nya memberi. */
  note: string | null
  body: ToolBody | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/**
 * Persingkat home directory jadi `~`. Host bisa Linux atau macOS, dan hub tidak
 * pernah tahu home user di laptop sana — jadi ditebak dari bentuk path-nya.
 */
export function shortPath(p: string): string {
  return p.replace(/^\/(home|Users)\/[^/]+/, '~')
}

/** Tebak bahasa dari ekstensi; dipakai hanya sebagai label, bukan untuk parsing. */
export function langOf(path: string | null): string | null {
  if (!path) return null
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', svelte: 'svelte', vue: 'vue',
    json: 'json', jsonc: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
    md: 'markdown', mdx: 'markdown', html: 'html', css: 'css', scss: 'scss',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
    php: 'php', c: 'c', h: 'c', cpp: 'c++', cs: 'c#', swift: 'swift',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
    sql: 'sql', env: 'env', conf: 'conf', ini: 'ini', xml: 'xml',
  }
  return map[ext] ?? null
}

const json = (v: unknown): ToolBody => ({ kind: 'json', text: safeJson(v) })

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    return String(v)
  }
}

/**
 * Input yang masih parsial (tool sedang di-stream) tidak pernah sampai ke sini
 * sebagai objek — pemanggil yang menanganinya, karena JSON-nya belum valid.
 */
export function toolView(name: string, input: unknown): ToolView {
  const o = (input ?? {}) as Record<string, unknown>
  const base = { name, target: null, note: null, body: null } as ToolView

  switch (name) {
    case 'Bash':
    case 'BashOutput': {
      const cmd = str(o.command)
      return {
        ...base,
        note: str(o.description),
        body: cmd ? { kind: 'shell', text: cmd } : json(o),
      }
    }

    case 'Read': {
      const p = str(o.file_path)
      const range =
        o.offset || o.limit
          ? `baris ${Number(o.offset ?? 0) + 1}–${Number(o.offset ?? 0) + Number(o.limit ?? 0)}`
          : str(o.pages)
            ? `halaman ${str(o.pages)}`
            : null
      return { ...base, target: p ? shortPath(p) : null, note: range }
    }

    case 'Write': {
      const p = str(o.file_path)
      const content = str(o.content)
      return {
        ...base,
        target: p ? shortPath(p) : null,
        body: content ? { kind: 'code', text: content, lang: langOf(p) } : null,
      }
    }

    case 'Edit':
    case 'NotebookEdit': {
      const p = str(o.file_path) ?? str(o.notebook_path)
      const before = str(o.old_string) ?? str(o.old_source) ?? ''
      const after = str(o.new_string) ?? str(o.new_source) ?? ''
      return {
        ...base,
        target: p ? shortPath(p) : null,
        note: o.replace_all ? 'ganti semua kemunculan' : null,
        body: before || after ? { kind: 'diff', before, after } : json(o),
      }
    }

    case 'Glob':
    case 'Grep': {
      const pattern = str(o.pattern)
      const where = str(o.path) ?? str(o.glob)
      return {
        ...base,
        target: pattern,
        note: where ? `di ${shortPath(where)}` : null,
      }
    }

    case 'WebFetch':
    case 'WebSearch': {
      return {
        ...base,
        target: str(o.url) ?? str(o.query),
        body: str(o.prompt) ? { kind: 'text', text: str(o.prompt)! } : null,
      }
    }

    case 'Task': {
      return {
        ...base,
        target: str(o.subagent_type),
        note: str(o.description),
        body: str(o.prompt) ? { kind: 'text', text: str(o.prompt)! } : null,
      }
    }

    case 'TodoWrite': {
      const todos = Array.isArray(o.todos) ? o.todos : []
      const items = todos
        .map((t) => {
          const r = (t ?? {}) as Record<string, unknown>
          return { text: str(r.content) ?? str(r.activeForm) ?? '', status: String(r.status ?? '') }
        })
        .filter((t) => t.text)
      return {
        ...base,
        note: `${items.length} langkah`,
        body: items.length ? { kind: 'todo', items } : json(o),
      }
    }

    default: {
      // Tool tak dikenal: kalau isinya cuma satu field string, itu hampir pasti
      // yang ingin dilihat. Sisanya JSON ter-indent.
      const keys = Object.keys(o)
      if (keys.length === 1 && typeof o[keys[0]!] === 'string') {
        return { ...base, note: keys[0]!, body: { kind: 'text', text: o[keys[0]!] as string } }
      }
      return { ...base, body: keys.length ? json(o) : null }
    }
  }
}

/**
 * Hasil tool jadi teks. Bentuknya bisa string, array blok konten SDK, atau
 * objek — ketiganya nyata, jadi ketiganya ditangani di satu tempat.
 */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((x) => {
        const r = (x ?? {}) as Record<string, unknown>
        return typeof r.text === 'string' ? r.text : typeof x === 'string' ? x : safeJson(x)
      })
      .join('\n')
  }
  if (content == null) return ''
  return safeJson(content)
}
