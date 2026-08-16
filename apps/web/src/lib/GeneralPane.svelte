<script lang="ts">
  import { askQuestions, nodeSlug, type LaneMeta } from '@company/protocol'
  import AskQuestions from './AskQuestions.svelte'
  import MentionInput from './MentionInput.svelte'
  import { store } from './store.svelte.ts'
  import ToolCall from './ToolCall.svelte'
  import Transcript from './Transcript.svelte'

  let { sessionId, closable }: { sessionId: string; closable: boolean } = $props()

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
    if (!t) return
    store.prompt(sessionId, t)
    gv.draft = ''
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
</script>

<section>
  <header>
    <div class="id">
      <div class="title">
        <span class="kind">general</span>
        {gv?.title ?? meta?.title ?? 'General'}
      </div>
      <div class="sub">
        {#if lanes.length}
          {lanes.length} node · {lanes.map(mentionOf).join(' ')}
        {:else}
          belum ada node — sebut dengan @nama di prompt
        {/if}
      </div>
    </div>
    <div class="right">
      {#if busy}
        <button class="icon" onclick={() => store.interrupt(sessionId)} title="Hentikan semua node">
          ■
        </button>
      {/if}
      {#if closable}
        <button class="icon" onclick={() => store.closePane(sessionId)} title="Tutup tab">✕</button>
      {/if}
    </div>
  </header>

  {#if !lanes.length}
    <div class="hint">
      <p>Satu prompt, beberapa laptop.</p>
      <p class="how">
        Sebut node-nya di depan prompt: <code>@laptop-kerja @vps cek versi node</code>.
        <br />
        <code>@all</code> menyasar semua node yang online, dan
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
    <div class="lanes">
      {#each lanes as lane (lane.sessionId)}
        {@const v = store.view(lane.sessionId)}
        {@const asking = v?.pending ? askQuestions(v.pending.name, v.pending.input) : null}
        <div class="lane">
          <div class="lanehead">
            <span class="dot" style:background={dot[lane.status]}></span>
            <span class="lanename" title={lane.cwd}>{laneLabel(lane)}</span>
            <span class="lanestatus">{statusLabel[lane.status] ?? lane.status}</span>
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

          {#if v?.pending && asking}
            {#key v.pending.reqId}
              <AskQuestions
                questions={asking}
                onSubmit={(answers) =>
                  store.approve(lane.sessionId, v!.pending!.reqId, 'allow', answers)}
                onSkip={() => store.approve(lane.sessionId, v!.pending!.reqId, 'deny')}
              />
            {/key}
          {:else if v?.pending}
            <div class="approval">
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

          {#if v?.loaded}
            <Transcript messages={v.messages} live={v.live} />
          {:else}
            <div class="blank">memuat…</div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <MentionInput
    value={gv?.draft ?? ''}
    disabled={!gv?.canPrompt}
    placeholder={gv?.canPrompt
      ? 'Sebut node dengan @, lalu tulis prompt…'
      : 'Hanya owner yang bisa mengirim prompt'}
    oninput={(v) => gv && (gv.draft = v)}
    onsubmit={submit}
  />
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
  .id {
    min-width: 0;
  }
  .title {
    font-weight: 600;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 7px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kind {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #a78bfa;
    border: 1px solid #4c3f7a;
    background: #241f3a;
    border-radius: 3px;
    padding: 1px 5px;
    flex: none;
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

  .lanes {
    flex: 1;
    display: flex;
    min-height: 0;
    overflow-x: auto;
  }
  .lane {
    flex: 1 0 340px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid #1b1f26;
  }
  .lane:last-child {
    border-right: none;
  }
  .lanehead {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 7px 12px;
    background: #12151a;
    border-bottom: 1px solid #1b1f26;
    font-size: 12px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
  }
  .lanename {
    color: #c9d1d9;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lanestatus {
    color: #6b7280;
    font-size: 11px;
    white-space: nowrap;
  }
  .auto {
    margin-left: auto;
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
    .lanes {
      flex-direction: column;
      overflow-x: hidden;
      overflow-y: auto;
    }
    .lane {
      flex: 1 0 auto;
      min-height: 260px;
      border-right: none;
      border-bottom: 1px solid #1b1f26;
    }
  }
</style>
