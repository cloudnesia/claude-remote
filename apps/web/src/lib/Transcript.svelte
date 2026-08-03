<script lang="ts">
  import type { Block, Message } from '@company/protocol'

  let { messages, live }: { messages: Message[]; live: Message | null } = $props()

  let box = $state<HTMLDivElement | null>(null)
  let pinned = $state(true)

  // Auto-scroll hanya kalau user memang sedang di bawah. Kalau dia sedang
  // membaca ke atas, menyeret layar tiap delta itu menyebalkan.
  $effect(() => {
    // sentuh isi supaya effect ikut berjalan saat teks bertambah
    void live?.blocks.map((b) => ('text' in b ? b.text.length : 0)).join()
    void messages.length
    if (pinned && box) box.scrollTop = box.scrollHeight
  })

  function onScroll() {
    if (!box) return
    pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 60
  }

  const preview = (b: Block & { kind: 'tool' }) =>
    typeof b.input === 'string' ? b.input : JSON.stringify(b.input)

  const resultText = (c: unknown) =>
    typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => x?.text ?? '').join('\n') : JSON.stringify(c)
</script>

<div class="scroll" bind:this={box} onscroll={onScroll}>
  {#each [...messages, ...(live ? [live] : [])] as m (m.id)}
    <article class={m.role}>
      <div class="who">{m.role === 'user' ? 'kamu' : 'claude'}</div>
      <div class="body">
        {#each m.blocks as b, i (i)}
          {#if b.kind === 'text'}
            <p class="text">{b.text}</p>
          {:else if b.kind === 'thinking'}
            <p class="thinking">{b.text}</p>
          {:else if b.kind === 'error'}
            <p class="errblock">{b.text}</p>
          {:else if b.kind === 'tool'}
            <div class="tool" class:running={!b.result}>
              <div class="tool-head">
                <span class="tool-name">{b.name}</span>
                {#if !b.done}<span class="hint">menyusun…</span>
                {:else if !b.result}<span class="hint">berjalan…</span>{/if}
              </div>
              <!-- Saat masih streaming, input sengaja ditampilkan mentah:
                   isinya JSON parsial yang belum bisa di-parse. -->
              <pre class="tool-input">{preview(b)}</pre>
              {#if b.result}
                <pre class="tool-result" class:err={!b.result.ok}>{resultText(b.result.content).slice(0, 2000)}</pre>
              {/if}
            </div>
          {/if}
        {/each}
        {#if m === live && m.blocks.length === 0}
          <p class="text pulse">…</p>
        {/if}
      </div>
    </article>
  {/each}
</div>

<style>
  .scroll {
    flex: 1;
    overflow-y: auto;
    padding: 20px 24px;
  }
  article {
    display: flex;
    gap: 14px;
    margin-bottom: 20px;
  }
  .who {
    width: 52px;
    flex: none;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
    padding-top: 2px;
  }
  article.user .who {
    color: #4a9eff;
  }
  .body {
    min-width: 0;
    flex: 1;
  }
  .text {
    margin: 0 0 8px;
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.6;
  }
  .thinking {
    margin: 0 0 8px;
    white-space: pre-wrap;
    color: #6b7280;
    font-style: italic;
    line-height: 1.6;
  }
  .pulse {
    color: #6b7280;
  }
  .errblock {
    margin: 0 0 8px;
    padding: 9px 12px;
    background: #2a1614;
    border: 1px solid #6b2c26;
    border-radius: 6px;
    color: #ffb3ae;
    font-size: 13px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .tool {
    border: 1px solid #23272f;
    border-radius: 6px;
    margin-bottom: 10px;
    overflow: hidden;
  }
  .tool.running {
    border-color: #2f4a6b;
  }
  .tool-head {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 6px 10px;
    background: #1b1f26;
  }
  .tool-name {
    font-size: 12px;
    font-weight: 600;
    color: #4a9eff;
  }
  .hint {
    font-size: 11px;
    color: #6b7280;
  }
  pre {
    margin: 0;
    padding: 8px 10px;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
  }
  .tool-input {
    color: #9aa3b2;
  }
  .tool-result {
    border-top: 1px solid #23272f;
    color: #7d8798;
    max-height: 220px;
    overflow-y: auto;
  }
  .tool-result.err {
    color: #e5534b;
  }
</style>
