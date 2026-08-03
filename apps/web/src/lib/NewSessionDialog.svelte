<script lang="ts">
  import { store } from './store.svelte.ts'
  import type { HostMeta } from '@company/protocol'

  let { host, onclose }: { host: HostMeta; onclose: () => void } = $props()

  let title = $state('')
  let titleTouched = $state(false)

  // Mulai dari home host. Path dibaca dari host, bukan ditebak browser —
  // browser tidak tahu apa-apa soal filesystem laptop itu.
  $effect(() => {
    store.browseResult = null
    store.browse(host.id, '')
  })

  const r = $derived(store.browseResult)
  const cwd = $derived(r?.path ?? '')

  // Judul mengikuti nama folder sampai user mengetik sendiri.
  const autoTitle = $derived(cwd.split('/').filter(Boolean).pop() ?? 'session')
  const effectiveTitle = $derived(titleTouched && title.trim() ? title.trim() : autoTitle)

  function create() {
    if (!cwd) return
    store.newSession(host.id, cwd, effectiveTitle)
    onclose()
  }
</script>

<div class="backdrop" role="button" tabindex="-1" onclick={onclose} onkeydown={(e) => e.key === 'Escape' && onclose()}></div>

<div class="modal">
  <h2>Session baru di {host.name}</h2>

  <div class="pathbar">
    <span class="label">Project directory</span>
    <code>{cwd || '…'}</code>
  </div>

  <div class="list" class:busy={store.browseBusy}>
    {#if r?.error}
      <div class="msg err">{r.error}</div>
    {:else if r}
      {#if r.parent}
        <button class="entry up" onclick={() => store.browse(host.id, r.parent!)}>
          <span class="ic">↰</span> ..
        </button>
      {/if}
      {#each r.entries as e (e.path)}
        <button class="entry" onclick={() => store.browse(host.id, e.path)}>
          <span class="ic">▸</span>
          {e.name}
        </button>
      {:else}
        <div class="msg">tidak ada subdirektori — folder ini bisa dipakai apa adanya</div>
      {/each}
    {:else}
      <div class="msg">memuat…</div>
    {/if}
  </div>

  <label class="titlerow">
    <span class="label">Judul</span>
    <input
      value={effectiveTitle}
      oninput={(e) => {
        titleTouched = true
        title = e.currentTarget.value
      }}
    />
  </label>

  <div class="acts">
    <button class="ghost" onclick={onclose}>Batal</button>
    <button class="go" onclick={create} disabled={!cwd || store.browseBusy}>
      Buat di sini
    </button>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: #0009;
    border: none;
  }
  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 460px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    background: #14171c;
    border: 1px solid #2b303a;
    border-radius: 10px;
    padding: 20px;
  }
  h2 {
    margin: 0 0 14px;
    font-size: 16px;
  }
  .label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: #6b7280;
  }
  .pathbar {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-bottom: 10px;
  }
  .pathbar code {
    font-family: ui-monospace, monospace;
    font-size: 13px;
    color: #4a9eff;
    word-break: break-all;
  }
  .list {
    flex: 1;
    min-height: 180px;
    max-height: 280px;
    overflow-y: auto;
    border: 1px solid #23272f;
    border-radius: 7px;
    background: #0f1115;
    padding: 4px;
  }
  .list.busy {
    opacity: 0.5;
  }
  .entry {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    background: none;
    border: none;
    color: #c9d1d9;
    font: inherit;
    font-size: 13px;
    text-align: left;
    padding: 5px 8px;
    border-radius: 5px;
    cursor: pointer;
  }
  .entry:hover {
    background: #1f2937;
  }
  .ic {
    color: #4b515c;
    font-size: 11px;
  }
  .up {
    color: #9aa3b2;
  }
  .msg {
    padding: 12px;
    font-size: 12px;
    color: #6b7280;
  }
  .msg.err {
    color: #e5534b;
  }
  .titlerow {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 14px 0 16px;
  }
  .titlerow input {
    background: #0f1115;
    border: 1px solid #23272f;
    border-radius: 7px;
    color: inherit;
    font: inherit;
    font-size: 13px;
    padding: 8px 11px;
  }
  .titlerow input:focus {
    outline: none;
    border-color: #3a4759;
  }
  .acts {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .acts button {
    border-radius: 7px;
    padding: 8px 16px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .go {
    background: #2563eb;
    color: #fff;
  }
  .go:disabled {
    background: #2b2f38;
    color: #6b7280;
    cursor: default;
  }
  .ghost {
    background: none;
    border-color: #2b303a;
    color: #9aa3b2;
  }
</style>
