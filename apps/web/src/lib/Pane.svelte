<script lang="ts">
  import { askQuestions } from '@company/protocol'
  import AskQuestions from './AskQuestions.svelte'
  import AttachChips from './AttachChips.svelte'
  import { filesToAttachments, type PendingAttachment } from './attachments.ts'
  import { store } from './store.svelte.ts'
  import ToolCall from './ToolCall.svelte'
  import Transcript from './Transcript.svelte'

  let { sessionId, closable }: { sessionId: string; closable: boolean } = $props()

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
    <header>
      <div class="id">
        <div class="title">{meta.title}</div>
        <div class="sub">{meta.cwd}</div>
      </div>
      <div class="right">
        <span
          class="status"
          class:warn={meta.status === 'waiting' || meta.status === 'ratelimited'}
          class:err={meta.status === 'error'}
        >
          {asking && meta.status === 'waiting'
            ? 'menunggu jawaban'
            : (statusLabel[meta.status] ?? meta.status)}
        </span>
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
        {#if meta.status === 'thinking' && view?.canPrompt}
          <button class="icon" onclick={() => store.interrupt(sessionId)} title="Hentikan">
            ■
          </button>
        {/if}
        {#if closable}
          <button class="icon" onclick={() => store.closePane(sessionId)} title="Tutup tab">
            ✕
          </button>
        {/if}
      </div>
    </header>

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
      <button
        type="button"
        class="clip"
        disabled={!view?.canPrompt}
        onclick={() => fileInput?.click()}
        title="Lampirkan foto atau PDF"
      >
        📎
      </button>
      <textarea
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
        disabled={!view?.canPrompt || (!view?.draft.trim() && !pending.length)}
      >
        Kirim
      </button>
    </form>
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
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    padding: 11px 16px;
    border-bottom: 1px solid #23272f;
  }
  .id {
    min-width: 0;
  }
  .title {
    font-weight: 600;
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
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
  .composer {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 12px 16px 14px;
    border-top: 1px solid #23272f;
  }
  .composer.dragover {
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
  textarea {
    flex: 1;
    min-width: 0;
    resize: none;
    background: #14171c;
    border: 1px solid #23272f;
    border-radius: 7px;
    color: inherit;
    font: inherit;
    font-size: 13px;
    padding: 8px 11px;
  }
  textarea:focus {
    outline: none;
    border-color: #3a4759;
  }
  textarea:disabled {
    color: #6b7280;
  }
  .composer button {
    background: #2563eb;
    border: none;
    color: #fff;
    border-radius: 7px;
    padding: 0 16px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    flex: none;
  }
  .composer button:disabled {
    background: #2b2f38;
    color: #6b7280;
    cursor: default;
  }

  /* Mobile responsive */
  @media (max-width: 768px) {
    header {
      padding: 8px 12px;
      flex-wrap: wrap;
      gap: 6px;
    }
    .id {
      flex: 1 1 100%;
    }
    .title {
      font-size: 15px;
    }
    .sub {
      font-size: 10px;
    }
    .right {
      gap: 6px;
      flex-wrap: wrap;
    }
    .icon {
      width: 32px;
      height: 32px;
      font-size: 15px;
    }
    .composer {
      padding: 10px 12px;
    }
    textarea {
      font-size: 14px;
      padding: 10px 12px;
    }
    .composer button {
      font-size: 14px;
      padding: 0 18px;
    }
    .clip {
      width: 40px;
      height: 40px;
      padding: 0;
      font-size: 17px;
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
