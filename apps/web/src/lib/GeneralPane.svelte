<script lang="ts">
  import { askQuestions, nodeSlug, type LaneMeta, type Message } from '@company/protocol'
  import AskQuestions from './AskQuestions.svelte'
  import AttachChips from './AttachChips.svelte'
  import { filesToAttachments, type PendingAttachment } from './attachments.ts'
  import MentionInput from './MentionInput.svelte'
  import { store } from './store.svelte.ts'
  import ToolCall from './ToolCall.svelte'
  import Transcript from './Transcript.svelte'

  let { sessionId }: { sessionId: string } = $props()

  let pending = $state<PendingAttachment[]>([])
  let fileInput = $state<HTMLInputElement | null>(null)
  let dragOver = $state(false)

  async function addFiles(files: FileList | File[] | null) {
    if (!files || !files.length) return
    const { attachments, errors } = await filesToAttachments(files, pending.length)
    if (attachments.length) pending = [...pending, ...attachments]
    if (errors.length) {
      store.notice = errors.join('; ')
      setTimeout(() => (store.notice = null), 4000)
    }
  }

  function onPick(e: Event) {
    addFiles((e.currentTarget as HTMLInputElement).files)
    if (fileInput) fileInput.value = ''
  }

  function onPaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.items ?? [])]
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f)
    if (files.length) addFiles(files)
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    dragOver = false
    if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files)
  }

  const gv = $derived(store.generalView(sessionId))
  const meta = $derived(store.generalMeta(sessionId))
  /** Status lane paling segar ada di roster; `general` cuma dikirim saat berubah. */
  const lanes = $derived<LaneMeta[]>(meta?.lanes ?? gv?.lanes ?? [])
  const busy = $derived(lanes.some((l) => l.status === 'thinking'))

  const statusLabel: Record<string, string> = {
    idle: 'siap',
    thinking: 'berpikir…',
    waiting: 'menunggu izin',
    ratelimited: 'rate limit',
    error: 'error',
    offline: 'offline',
  }

  const dot: Record<string, string> = {
    idle: '#5a6270',
    thinking: '#4a9eff',
    waiting: '#f5a623',
    ratelimited: '#f5a623',
    error: '#e5534b',
    offline: '#3a3f4a',
  }

  function submit() {
    if (!gv) return
    const t = gv.draft.trim()
    if (!t && !pending.length) return
    store.prompt(sessionId, t, pending)
    gv.draft = ''
    pending = []
  }

  /** Label lane: nama node saja, kecuali direktorinya bukan yang default. */
  const laneLabel = (l: LaneMeta) => (l.cwd === '~' ? l.hostName : `${l.hostName}:${l.cwd}`)

  /**
   * Sebutan yang mengarah persis ke lane ini. Direktori ikut ditulis kalau
   * bukan default — dua lane di node yang sama kalau tidak akan tampak sebagai
   * sebutan kembar yang tidak bisa dibedakan.
   */
  const mentionOf = (l: LaneMeta) =>
    l.cwd === '~' ? `@${nodeSlug(l.hostName)}` : `@${nodeSlug(l.hostName)}:${l.cwd}`

  function textOf(m: Message): string {
    const b = m.blocks.find((x): x is Extract<(typeof m.blocks)[number], { kind: 'text' }> => x.kind === 'text')
    return b?.text ?? ''
  }

  /**
   * Dulu tiap node dapat kolomnya sendiri (satu prompt → N transcript
   * berdampingan). Sekarang digabung jadi SATU percakapan, kronologis,
   * dengan balasan tiap node ditandai lewat `labelFor` di Transcript —
   * lebih terasa seperti satu chat, bukan N chat kebetulan sejajar.
   *
   * Dua hal yang perlu dijaga di sini:
   * 1. Prompt user yang sama dikirim ke SEMUA lane target dalam satu
   *    submit — kalau tidak di-dedup, prompt itu muncul N kali berturut-
   *    turut di transcript gabungan. Di-dedup lewat teks + jendela waktu
   *    (bukan id: seq per-lane independen, jadi kalimat yang sama bisa
   *    kebetulan lain waktu bukan bagian dari fan-out yang sama).
   * 2. `Message.id` unik cuma DALAM satu lane (seq per-session). Dua lane
   *    yang sama-sama baru mulai bisa sama-sama punya id `u_1` — tanpa
   *    prefix sessionId, itu tabrakan key di {#each} Transcript.
   */
  const merged = $derived.by(() => {
    const messages: Message[] = []
    const live: Message[] = []
    const labels = new Map<string, string>()
    const seenUser: { text: string; ts: number }[] = []

    for (const lane of lanes) {
      const v = store.view(lane.sessionId)
      if (!v) continue
      const label = laneLabel(lane)

      for (const m of v.messages) {
        if (m.role === 'user') {
          const text = textOf(m)
          if (seenUser.some((u) => u.text === text && Math.abs(u.ts - m.ts) < 5000)) continue
          seenUser.push({ text, ts: m.ts })
        }
        const id = `${lane.sessionId}:${m.id}`
        if (m.role === 'assistant') labels.set(id, label)
        messages.push({ ...m, id })
      }
      if (v.live) {
        const id = `${lane.sessionId}:${v.live.id}`
        labels.set(id, label)
        live.push({ ...v.live, id })
      }
    }

    messages.sort((a, b) => a.ts - b.ts)
    return { messages, live, labels }
  })
</script>

<section>
  <header>
    <div class="sub">
      {#if lanes.length}
        {lanes.length} node · {lanes.map(mentionOf).join(' ')}
      {:else}
        belum ada node — sebut dengan @nama di prompt
      {/if}
    </div>
    <div class="right">
      {#if busy}
        <button class="icon" onclick={() => store.interrupt(sessionId)} title="Hentikan semua node">
          ■
        </button>
      {/if}
    </div>
  </header>

  {#if !lanes.length}
    <div class="hint">
      <p>Satu prompt, beberapa laptop.</p>
      <p class="how">
        Sebut node-nya di depan prompt: <code>@laptop-kerja @vps cek versi node</code> —
        keduanya jalan BERGANTIAN sesuai urutan ketik (bukan sekaligus), dan hasil
        node sebelumnya ikut disisipkan sebagai konteks ke node berikutnya.
        <br />
        <code>@all</code> beda: menyasar semua node online SEKALIGUS (paralel).
        <code>@node:/path/ke/project</code> menjalankannya di direktori tertentu
        (default: home).
      </p>
      {#if store.myHosts.length}
        <div class="chips">
          {#each store.myHosts as h (h.id)}
            <button
              class="chip"
              class:off={!h.online}
              onclick={() => gv && (gv.draft = `${gv.draft}@${nodeSlug(h.name)} `.trimStart())}
            >
              @{nodeSlug(h.name)}{h.online ? '' : ' (offline)'}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <!-- Status ringkas per node — dulu ini header tiap kolom, sekarang satu
         strip di atas satu transcript gabungan (lihat `merged` di script). -->
    <div class="node-strip">
      {#each lanes as lane (lane.sessionId)}
        {@const v = store.view(lane.sessionId)}
        <div class="node-chip">
          <span class="dot" style:background={dot[lane.status]}></span>
          <span class="node-name" title={lane.cwd}>{laneLabel(lane)}</span>
          <span class="node-status">{statusLabel[lane.status] ?? lane.status}</span>
          {#if v}
            <button
              class="auto"
              class:on={v.auto}
              onclick={() => store.setAuto(lane.sessionId, !v.auto)}
              title={v.auto
                ? 'Auto mode AKTIF di node ini — tool jalan tanpa minta izin.'
                : 'Auto mode mati — tiap tool minta izin dulu.'}
            >
              auto {v.auto ? 'on' : 'off'}
            </button>
          {/if}
        </div>
      {/each}
    </div>

    <!-- Kartu approval tetap per-lane (bukan bagian dari transcript gabungan
         — ini keputusan aktif yang harus jelas node mana yang menunggu),
         bisa lebih dari satu tampil sekaligus kalau beberapa node minta
         izin bersamaan. -->
    {#each lanes as lane (lane.sessionId)}
      {@const v = store.view(lane.sessionId)}
      {@const asking = v?.pending ? askQuestions(v.pending.name, v.pending.input) : null}
      {#if v?.pending && asking}
        {#key v.pending.reqId}
          <div class="approval-block">
            <div class="approval-source">{laneLabel(lane)}</div>
            <AskQuestions
              questions={asking}
              onSubmit={(answers) =>
                store.approve(lane.sessionId, v!.pending!.reqId, 'allow', answers)}
              onSkip={() => store.approve(lane.sessionId, v!.pending!.reqId, 'deny')}
            />
          </div>
        {/key}
      {:else if v?.pending}
        <div class="approval">
          <div class="approval-source">{laneLabel(lane)}</div>
          <div class="ask">
            <div class="asktitle">minta izin jalan</div>
            <ToolCall
              block={{
                kind: 'tool',
                id: v.pending.reqId,
                name: v.pending.name,
                input: v.pending.input,
                done: true,
              }}
              compact
            />
          </div>
          <div class="acts">
            <button class="deny" onclick={() => store.approve(lane.sessionId, v.pending!.reqId, 'deny')}>
              Tolak
            </button>
            <button class="allow" onclick={() => store.approve(lane.sessionId, v.pending!.reqId, 'allow')}>
              Izinkan
            </button>
          </div>
        </div>
      {/if}
    {/each}

    {#if lanes.some((l) => store.view(l.sessionId)?.loaded)}
      <Transcript
        messages={merged.messages}
        live={merged.live}
        labelFor={(m) => merged.labels.get(m.id)}
      />
    {:else}
      <div class="blank">memuat…</div>
    {/if}
  {/if}

  <AttachChips attachments={pending} onremove={(id) => (pending = pending.filter((a) => a.id !== id))} />

  <div
    class="attach-row"
    class:dragover={dragOver}
    role="group"
    aria-label="Composer, drag-drop foto atau PDF di sini"
    ondragover={(e) => {
      e.preventDefault()
      dragOver = true
    }}
    ondragleave={() => (dragOver = false)}
    ondrop={onDrop}
  >
    <input
      bind:this={fileInput}
      type="file"
      accept="image/jpeg,image/png,image/gif,image/webp,application/pdf"
      multiple
      hidden
      onchange={onPick}
    />
    <button
      type="button"
      class="clip"
      disabled={!gv?.canPrompt}
      onclick={() => fileInput?.click()}
      title="Lampirkan foto atau PDF"
    >
      📎
    </button>
    <MentionInput
      value={gv?.draft ?? ''}
      disabled={!gv?.canPrompt}
      placeholder={gv?.canPrompt
        ? 'Sebut node dengan @, lalu tulis prompt… (tempel/drag foto atau PDF juga bisa)'
        : 'Hanya owner yang bisa mengirim prompt'}
      oninput={(v) => gv && (gv.draft = v)}
      onsubmit={submit}
      onpaste={onPaste}
      hasAttachments={pending.length > 0}
    />
  </div>
</section>

<style>
  section {
    flex: 1 1 0;
    min-width: 0;
    /* Sama seperti Pane.svelte: parent sekarang column-flex (tab bar), jadi
       tanpa ini section tidak pernah menyusut di bawah tinggi kontennya dan
       halaman ikut memanjang alih-alih lane di dalamnya yang scroll. */
    min-height: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid #23272f;
  }
  section:last-child {
    border-right: none;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    padding: 11px 16px;
    border-bottom: 1px solid #23272f;
  }
  .sub {
    min-width: 0;
    font-size: 11px;
    color: #6b7280;
    font-family: ui-monospace, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  .icon {
    background: #2b2f38;
    border: 1px solid #3a3f4a;
    color: #c9d1d9;
    border-radius: 5px;
    width: 28px;
    height: 28px;
    line-height: 1;
    font-size: 14px;
    cursor: pointer;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .icon:hover {
    color: #fff;
    border-color: #4a9eff;
    background: #3a4759;
  }

  .hint {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 24px;
    text-align: center;
    color: #6b7280;
    font-size: 13px;
  }
  .hint p {
    margin: 0;
  }
  .hint .how {
    max-width: 460px;
    font-size: 12px;
    color: #4b515c;
    line-height: 1.8;
  }
  .hint code {
    background: #1f242c;
    border: 1px solid #2b303a;
    border-radius: 4px;
    padding: 1px 5px;
    font-family: ui-monospace, monospace;
    color: #a78bfa;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: center;
    margin-top: 8px;
  }
  .chip {
    background: #1f242c;
    border: 1px solid #2b303a;
    color: #9aa3b2;
    border-radius: 999px;
    font: inherit;
    font-size: 12px;
    padding: 3px 10px;
    cursor: pointer;
  }
  .chip:hover {
    border-color: #4a9eff;
    color: #e6e9ef;
  }
  .chip.off {
    color: #4b515c;
  }

  /* Satu strip status ringkas, satu chip per node — pengganti kolom
     berdampingan lama. Transcript-nya sendiri sudah digabung jadi satu
     (lihat `merged` di script + <Transcript labelFor=...> di markup). */
  .node-strip {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 16px 0;
  }
  .node-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: #1a1d24;
    border: 1px solid #23272f;
    border-radius: 999px;
    font-size: 11px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
  }
  .node-name {
    color: #c9d1d9;
    font-weight: 600;
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .node-status {
    color: #6b7280;
    font-size: 10px;
    white-space: nowrap;
  }
  .auto {
    background: none;
    border: 1px solid #3a3f4a;
    color: #6b7280;
    border-radius: 5px;
    font: inherit;
    font-size: 10px;
    padding: 1px 6px;
    cursor: pointer;
    flex: none;
  }
  .auto.on {
    background: #3a2a12;
    border-color: #8a6a20;
    color: #f5a623;
  }
  .blank {
    flex: 1;
    display: grid;
    place-items: center;
    color: #4b515c;
    font-size: 13px;
  }
  .attach-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 12px 16px 14px;
    border-top: 1px solid #23272f;
  }
  .attach-row.dragover {
    background: rgba(74, 158, 255, 0.06);
    outline: 1.5px dashed #4a9eff;
    outline-offset: -4px;
  }
  .clip {
    flex: none;
    background: none;
    border: 1px solid #3a3f4a;
    color: #9aa3b2;
    border-radius: 7px;
    width: 36px;
    height: 36px;
    font-size: 15px;
    cursor: pointer;
    padding: 0;
  }
  .clip:hover:not(:disabled) {
    color: #4a9eff;
    border-color: #4a9eff;
  }
  .clip:disabled {
    color: #4b515c;
    cursor: default;
  }
  .approval-block {
    margin: 8px 16px 0;
  }
  .approval-source {
    display: inline-block;
    margin-bottom: 5px;
    padding: 1px 6px;
    background: #1f242c;
    border: 1px solid #2b303a;
    border-radius: 3px;
    color: #a78bfa;
    font-size: 10px;
    font-weight: 600;
  }
  .approval {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 8px 12px 0;
    padding: 9px 11px;
    background: #2a2313;
    border: 1px solid #6b5416;
    border-radius: 7px;
    font-size: 12px;
  }
  .ask {
    min-width: 0;
  }
  .asktitle {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: #c9a86a;
    margin-bottom: 6px;
  }
  .acts {
    display: flex;
    gap: 6px;
  }
  .acts button {
    border-radius: 5px;
    padding: 4px 10px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    border: 1px solid transparent;
    flex: 1;
  }
  .allow {
    background: #f5a623;
    color: #1a1d23;
    font-weight: 600;
  }
  .deny {
    background: none;
    border-color: #6b5416;
    color: #c9a86a;
  }

  @media (max-width: 768px) {
    header {
      padding: 8px 12px;
    }
    .node-strip {
      padding: 8px 12px 0;
    }
    .attach-row {
      padding: 10px 12px;
    }
    .clip {
      width: 40px;
      height: 40px;
      padding: 0;
      font-size: 17px;
    }
  }
</style>
