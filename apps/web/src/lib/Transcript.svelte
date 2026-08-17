<script lang="ts">
  import type { Message } from '@company/protocol'
  import ToolCall from './ToolCall.svelte'

  let { messages, live }: { messages: Message[]; live: Message | null } = $props()

  let box = $state<HTMLDivElement | null>(null)
  let pinned = $state(true)
  let lastContentHeight = $state(0)

  // Auto-scroll hanya kalau user memang sedang di bawah. Kalau dia sedang
  // membaca ke atas, menyeret layar tiap delta itu menyebalkan.
  $effect(() => {
    // sentuh isi supaya effect ikut berjalan saat teks bertambah
    void live?.blocks.map((b) => ('text' in b ? b.text.length : 0)).join()
    void messages.length

    if (box) {
      const newHeight = box.scrollHeight
      // Auto-scroll jika:
      // 1. User sedang pinned (di bagian bawah)
      // 2. Ada konten baru (height berubah)
      if (pinned && newHeight !== lastContentHeight) {
        // Gunakan requestAnimationFrame untuk smooth scroll
        requestAnimationFrame(() => {
          if (box) {
            box.scrollTop = box.scrollHeight
          }
        })
        lastContentHeight = newHeight
      }
    }
  })

  function onScroll() {
    if (!box) return
    // Lebih toleran: 80px threshold agar user tidak terlalu sensitif
    pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 80
  }

  function scrollToBottom() {
    if (box) {
      box.scrollTo({
        top: box.scrollHeight,
        behavior: 'smooth'
      })
      pinned = true
    }
  }

</script>

<div class="wrapper">
  <div class="scroll" bind:this={box} onscroll={onScroll}>
    {#each [...messages, ...(live ? [live] : [])] as m (m.id)}
    <article class={m.role}>
      <div class="who">{m.role === 'user' ? 'user' : 'claude'}</div>
      <div class="body">
        {#each m.blocks as b, i (i)}
          {#if b.kind === 'text'}
            <p class="text">{b.text}</p>
          {:else if b.kind === 'thinking'}
            <p class="thinking">{b.text}</p>
          {:else if b.kind === 'error'}
            <p class="errblock">{b.text}</p>
          {:else if b.kind === 'tool'}
            <ToolCall block={b} />
          {:else if b.kind === 'attachment'}
            <div class="attachment" title={b.mime}>
              <span class="ico">{b.mime.startsWith('image/') ? '🖼' : '📎'}</span>
              {b.name}
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

  {#if !pinned}
    <button class="scroll-down" onclick={scrollToBottom} title="Scroll ke bawah">
      ↓
    </button>
  {/if}
</div>

<style>
  .wrapper {
    flex: 1;
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
    padding: 20px 24px;
    scroll-behavior: smooth;
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
  .attachment {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0 6px 8px 0;
    padding: 4px 9px;
    background: #1f242c;
    border: 1px solid #2b303a;
    border-radius: 999px;
    font-size: 12px;
    color: #9aa3b2;
  }
  .attachment .ico {
    font-size: 12px;
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
  .scroll-down {
    position: absolute;
    bottom: 20px;
    right: 24px;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: #2563eb;
    border: none;
    color: #fff;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    transition: all 0.2s ease;
    z-index: 5;
  }
  .scroll-down:hover {
    background: #1d4ed8;
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
  }
  .scroll-down:active {
    transform: translateY(0);
  }

  /* Mobile styles untuk scroll-down button */
  @media (max-width: 768px) {
    .scroll-down {
      width: 48px;
      height: 48px;
      font-size: 24px;
      bottom: 16px;
      right: 16px;
    }
  }
</style>
