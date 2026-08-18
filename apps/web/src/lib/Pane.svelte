<script lang="ts">
  import { askQuestions } from '@company/protocol'
  import AskQuestions from './AskQuestions.svelte'
  import AttachChips from './AttachChips.svelte'
  import { filesToAttachments, type PendingAttachment } from './attachments.ts'
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

  const meta = $derived(store.meta(sessionId))
  const view = $derived(store.view(sessionId))
  const models = $derived(store.modelsFor(sessionId))

  /**
   * Jalan keluar manual dari tampilan "berpikir". Composer disembunyikan
   * total selama status thinking (lihat catatan di markup) — kalau status-nya
   * macet tidak pernah balik ke idle (mis. Stop gagal, atau `result` dari SDK
   * tidak pernah sampai), tanpa ini pengguna terkunci total, tidak bisa
   * ngetik apa pun sampai reload. Direset begitu status memang berubah,
   * supaya giliran berikutnya tetap mulai dari tampilan berpikir seperti
   * biasa, bukan permanen ter-force.
   */
  let forceComposer = $state(false)
  $effect(() => {
    if (meta?.status !== 'thinking') forceComposer = false
  })
  /** Non-null kalau yang menunggu bukan izin tool, tapi pertanyaan buat owner. */
  const asking = $derived(
    view?.pending ? askQuestions(view.pending.name, view.pending.input) : null,
  )

  const statusLabel: Record<string, string> = {
    idle: 'siap',
    thinking: 'berpikir…',
    waiting: 'menunggu izin',
    ratelimited: 'kena rate limit',
    error: 'error',
    offline: 'host offline',
  }

  function submit(e: Event) {
    e.preventDefault()
    const v = view
    if (!v) return
    const t = v.draft.trim()
    if (!t && !pending.length) return
    store.prompt(sessionId, t, pending)
    v.draft = ''
    pending = []
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit(e)
    }
  }
</script>

<section>
  {#if !meta}
    <div class="blank">session tidak ditemukan</div>
  {:else}
    {#if view?.pending && asking && view.canPrompt}
      <!-- key: tiap permintaan baru harus mulai dengan pilihan kosong, bukan
           mewarisi state jawaban pertanyaan sebelumnya. -->
      {#key view.pending.reqId}
        <AskQuestions
          questions={asking}
          onSubmit={(answers) => store.approve(sessionId, view!.pending!.reqId, 'allow', answers)}
          onSkip={() => store.approve(sessionId, view!.pending!.reqId, 'deny')}
        />
      {/key}
    {:else if view?.pending}
      <div class="approval">
        <div class="ask">
          {#if asking}
            <!-- Viewer non-owner: pertanyaannya tetap ditampilkan supaya jelas
                 kenapa session berhenti, tapi hanya owner yang boleh menjawab. -->
            <strong>Claude bertanya</strong> ke owner
            <pre>{asking.map((q) => q.question).join('\n')}</pre>
          {:else}
            <div class="asktitle">minta izin jalan</div>
            <!-- Perintahnya ditampilkan sebagaimana nanti muncul di transcript,
                 bukan sebagai JSON: yang menyetujui harus bisa membacanya. -->
            <ToolCall
              block={{
                kind: 'tool',
                id: view.pending.reqId,
                name: view.pending.name,
                input: view.pending.input,
                done: true,
              }}
              compact
            />
          {/if}
        </div>
        {#if view.canPrompt}
          <div class="acts">
            <button class="deny" onclick={() => store.approve(sessionId, view.pending!.reqId, 'deny')}>
              Tolak
            </button>
            <button class="allow" onclick={() => store.approve(sessionId, view.pending!.reqId, 'allow')}>
              Izinkan
            </button>
          </div>
        {:else}
          <span class="note">menunggu owner</span>
        {/if}
      </div>
    {/if}

    {#if view?.loaded}
      <Transcript messages={view.messages} live={view.live} />
    {:else}
      <div class="blank">memuat…</div>
    {/if}

    <!--
      Model, auto-mode, status, dan tombol stop dulunya di header — sekarang
      satu unit dengan composer, dan TOGGLE dengan tampilan "berpikir": begitu
      Claude mulai menjawab, seluruh baris input (model/auto/status/textarea)
      diganti indikator tengah + tombol stop, bukan disembunyikan sebagian.
      Trade-off yang disadari: prompt susulan tidak bisa diantre sambil giliran
      sebelumnya masih jalan (dulu bisa, lewat textarea yang tetap aktif).

      `forceComposer` adalah jalan keluar manual: kalau status macet di
      thinking (Stop gagal, atau event akhir dari SDK tidak pernah sampai),
      composer yang disembunyikan total ini bisa mengunci pengguna — tidak
      bisa ngetik apa pun sampai reload. Tombol kecil di bawah Stop selalu
      tersedia untuk memaksa composer muncul lagi tanpa menunggu status
      berubah.
    -->
    {#if meta.status === 'thinking' && !forceComposer}
      <div class="thinking-bar">
        <span class="thinking-text">
          Berpikir
          <span class="dots"><i></i><i></i><i></i></span>
        </span>
        {#if view?.canPrompt}
          <button type="button" class="stop" onclick={() => store.interrupt(sessionId)}>
            ■ Stop
          </button>
        {/if}
      </div>
      <button type="button" class="force-composer" onclick={() => (forceComposer = true)}>
        Composer tidak muncul lagi? Tampilkan paksa
      </button>
    {:else}
      <div class="toolbar">
        {#if view?.canPrompt && models.length}
          <select
            class="model"
            value={view.model ?? ''}
            onchange={(e) => store.setModel(sessionId, e.currentTarget.value || null)}
            title="Model untuk session ini"
          >
            {#each models as m (m.value)}
              <option value={m.value === 'default' ? '' : m.value}>{m.displayName}</option>
            {/each}
          </select>
        {:else if meta.model}
          <span class="model ro">{meta.model}</span>
        {/if}
        {#if view?.canPrompt}
          <button
            class="auto"
            class:on={view.auto}
            onclick={() => store.setAuto(sessionId, !view.auto)}
            title={view.auto
              ? 'Auto mode AKTIF — tool jalan tanpa minta izin. Klik untuk matikan.'
              : 'Auto mode mati — tiap tool minta izin dulu. Klik untuk aktifkan.'}
          >
            auto {view.auto ? 'on' : 'off'}
          </button>
        {:else if meta.auto}
          <span class="auto on ro">auto on</span>
        {/if}
        {#if meta.status !== 'idle'}
          <span
            class="status"
            class:warn={meta.status === 'waiting' || meta.status === 'ratelimited'}
            class:err={meta.status === 'error'}
          >
            {asking && meta.status === 'waiting'
              ? 'menunggu jawaban'
              : (statusLabel[meta.status] ?? meta.status)}
          </span>
        {/if}
      </div>

      <AttachChips attachments={pending} onremove={(id) => (pending = pending.filter((a) => a.id !== id))} />

      <form
        class="composer"
        class:dragover={dragOver}
        onsubmit={submit}
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
        <div class="input-shell">
          <button
            type="button"
            class="icon-btn clip"
            disabled={!view?.canPrompt}
            onclick={() => fileInput?.click()}
            title="Lampirkan foto atau PDF"
          >
            📎
          </button>
          <textarea
            class="composer-input"
            value={view?.draft ?? ''}
            oninput={(e) => {
              if (view) view.draft = e.currentTarget.value
            }}
            onkeydown={onKeydown}
            onpaste={onPaste}
            rows="2"
            disabled={!view?.canPrompt}
            placeholder={view?.canPrompt
              ? 'Tulis prompt… (tempel/drag foto atau PDF juga bisa)'
              : meta.status === 'offline'
                ? 'Host offline — hanya bisa dibaca'
                : 'Hanya owner yang bisa mengirim prompt'}
          ></textarea>
          <button
            type="submit"
            class="icon-btn send"
            disabled={!view?.canPrompt || (!view?.draft.trim() && !pending.length)}
            title="Kirim"
          >
            ➤
          </button>
        </div>
      </form>
    {/if}
  {/if}
</section>

<style>
  section {
    flex: 1 1 0;
    min-width: 0;
    /* Wajib: parent (`main` di +page.svelte) sekarang flex-direction column
       sejak tab bar ada. Tanpa ini, default `min-height: auto` bikin section
       tidak pernah menyusut di bawah tinggi kontennya — transcript panjang
       mendorong seluruh halaman melebar ke bawah alih-alih Transcript-nya
       sendiri yang scroll (overflow-y: auto di Transcript.svelte jadi
       percuma karena tidak pernah dapat tinggi yang dibatasi). */
    min-height: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid #23272f;
  }
  section:last-child {
    border-right: none;
  }
  .status {
    font-size: 11px;
    color: #6b7280;
    white-space: nowrap;
  }
  .status.warn {
    color: #f5a623;
  }
  .status.err {
    color: #e5534b;
  }
  .model {
    background: #1f242c;
    border: 1px solid #3a3f4a;
    color: #9aa3b2;
    border-radius: 5px;
    font: inherit;
    font-size: 11px;
    padding: 2px 4px;
    cursor: pointer;
    max-width: 110px;
  }
  .model:focus {
    outline: none;
    border-color: #3a4759;
  }
  .model.ro {
    cursor: default;
    padding: 2px 7px;
  }
  .auto {
    background: none;
    border: 1px solid #3a3f4a;
    color: #6b7280;
    border-radius: 5px;
    font: inherit;
    font-size: 10px;
    letter-spacing: 0.04em;
    padding: 2px 7px;
    cursor: pointer;
    white-space: nowrap;
  }
  .auto:hover {
    color: #c9d1d9;
  }
  .auto.on {
    background: #3a2a12;
    border-color: #8a6a20;
    color: #f5a623;
  }
  .auto.ro {
    cursor: default;
  }
  .blank {
    flex: 1;
    display: grid;
    place-items: center;
    color: #4b515c;
    font-size: 13px;
  }
  .approval {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 10px 16px 0;
    padding: 10px 12px;
    background: #2a2313;
    border: 1px solid #6b5416;
    border-radius: 7px;
    font-size: 13px;
  }
  .ask {
    min-width: 0;
  }
  .asktitle {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: #c9a86a;
    margin-bottom: 7px;
  }
  .approval pre {
    margin: 5px 0 0;
    font-size: 11px;
    color: #c9a86a;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 90px;
    overflow-y: auto;
  }
  .acts {
    display: flex;
    gap: 6px;
    flex: none;
    justify-content: flex-end;
  }
  .acts button {
    border-radius: 5px;
    padding: 5px 11px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    border: 1px solid transparent;
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
  .note {
    font-size: 11px;
    color: #8a7749;
    flex: none;
  }

  /* ---------------------------------------------------------------- toolbar */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px 0;
  }

  /* ------------------------------------------------------------ composer */
  .composer {
    display: flex;
    padding: 8px 16px 14px;
    border-top: 1px solid transparent;
  }
  .composer.dragover {
    background: rgba(74, 158, 255, 0.06);
    outline: 1.5px dashed #4a9eff;
    outline-offset: -4px;
  }
  .input-shell {
    position: relative;
    flex: 1;
    min-width: 0;
  }
  .composer-input {
    width: 100%;
    box-sizing: border-box;
    resize: none;
    background: #14171c;
    border: 1px solid #23272f;
    border-radius: 10px;
    color: inherit;
    font: inherit;
    font-size: 13px;
    padding: 10px 46px;
  }
  .composer-input:focus {
    outline: none;
    border-color: #3a4759;
  }
  .composer-input:disabled {
    color: #6b7280;
  }
  /* Ikon dikunci di dalam kotak input (bottom-left/bottom-right) — tidak lagi
     ikut flex row bersama textarea, jadi posisinya tidak goyang mengikuti
     tinggi textarea atau elemen di sebelahnya. */
  .icon-btn {
    position: absolute;
    bottom: 7px;
    width: 30px;
    height: 30px;
    border: none;
    border-radius: 7px;
    background: none;
    color: #9aa3b2;
    font-size: 14px;
    line-height: 1;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .icon-btn.clip {
    left: 7px;
  }
  .icon-btn.clip:hover:not(:disabled) {
    color: #4a9eff;
  }
  .icon-btn.clip:disabled {
    color: #4b515c;
    cursor: default;
  }
  .icon-btn.send {
    right: 7px;
    background: #2563eb;
    color: #fff;
    font-size: 13px;
  }
  .icon-btn.send:hover:not(:disabled) {
    background: #1d4ed8;
  }
  .icon-btn.send:disabled {
    background: #2b2f38;
    color: #6b7280;
    cursor: default;
  }

  /* ------------------------------------------------------------ thinking */
  .thinking-bar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 18px;
    padding: 18px 16px;
    border-top: 1px solid #23272f;
  }
  .thinking-text {
    display: flex;
    align-items: center;
    color: #9aa3b2;
    font-size: 13px;
  }
  .dots {
    display: inline-flex;
    gap: 3px;
    margin-left: 7px;
  }
  .dots i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.3;
    animation: dotpulse 1.2s infinite;
  }
  .dots i:nth-child(2) {
    animation-delay: 0.2s;
  }
  .dots i:nth-child(3) {
    animation-delay: 0.4s;
  }
  @keyframes dotpulse {
    0%,
    60%,
    100% {
      opacity: 0.3;
      transform: scale(0.85);
    }
    30% {
      opacity: 1;
      transform: scale(1);
    }
  }
  .stop {
    display: flex;
    align-items: center;
    gap: 6px;
    background: #2b1616;
    border: 1px solid #6b2c26;
    color: #ffb3ae;
    border-radius: 7px;
    padding: 7px 14px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .stop:hover {
    background: #3a1c19;
    border-color: #e5534b;
  }
  .force-composer {
    display: block;
    width: 100%;
    background: none;
    border: none;
    color: #4b515c;
    font: inherit;
    font-size: 11px;
    text-align: center;
    padding: 0 16px 12px;
    cursor: pointer;
  }
  .force-composer:hover {
    color: #9aa3b2;
    text-decoration: underline;
  }

  /* Mobile responsive */
  @media (max-width: 768px) {
    .toolbar {
      padding: 10px 12px 0;
      flex-wrap: wrap;
    }
    .composer {
      padding: 8px 12px 12px;
    }
    .composer-input {
      font-size: 14px;
      padding: 11px 48px;
    }
    .icon-btn {
      width: 34px;
      height: 34px;
      font-size: 16px;
    }
    .icon-btn.clip {
      left: 6px;
    }
    .icon-btn.send {
      right: 6px;
    }
    .model {
      font-size: 12px;
      padding: 4px 6px;
    }
    .auto {
      font-size: 11px;
      padding: 4px 8px;
    }
    .status {
      font-size: 12px;
    }
    .thinking-bar {
      padding: 16px 12px;
      gap: 12px;
    }
    .approval {
      margin: 8px 12px 0;
      padding: 8px 10px;
      flex-direction: column;
      gap: 8px;
    }
    .acts {
      width: 100%;
      justify-content: stretch;
    }
    .acts button {
      flex: 1;
    }
  }
</style>
