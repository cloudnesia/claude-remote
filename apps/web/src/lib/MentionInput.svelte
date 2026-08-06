<script lang="ts">
  import { MENTION_ALL, nodeSlug } from '@company/protocol'
  import { store } from './store.svelte.ts'

  let {
    value,
    disabled,
    placeholder,
    oninput,
    onsubmit,
  }: {
    value: string
    disabled: boolean
    placeholder: string
    oninput: (v: string) => void
    onsubmit: () => void
  } = $props()

  type Suggestion = { slug: string; label: string; note: string; online: boolean }

  let el = $state<HTMLTextAreaElement | null>(null)
  /** Posisi `@` yang sedang diketik, atau null kalau tidak sedang menyebut node. */
  let anchor = $state<number | null>(null)
  let queryText = $state('')
  let active = $state(0)

  const all = $derived<Suggestion[]>([
    ...store.myHosts.map((h) => ({
      slug: nodeSlug(h.name),
      label: h.name,
      note: h.online ? (h.platform ?? '') : 'offline',
      online: h.online,
    })),
    {
      slug: MENTION_ALL,
      label: 'semua node online',
      note: `${store.myHosts.filter((h) => h.online).length} node`,
      online: true,
    },
  ])

  const matches = $derived(
    anchor === null
      ? []
      : all.filter((s) => s.slug.includes(queryText) || s.label.toLowerCase().includes(queryText)),
  )

  const open = $derived(anchor !== null && matches.length > 0)

  /** Sebutan hanya valid di awal kata — `email@host` bukan alamat node. */
  function refresh(text: string, caret: number): void {
    const before = text.slice(0, caret)
    const m = before.match(/(?:^|\s)@([A-Za-z0-9._-]*)$/)
    if (!m) {
      anchor = null
      return
    }
    anchor = caret - m[1]!.length - 1
    queryText = m[1]!.toLowerCase()
    active = 0
  }

  function onInputEvent(e: Event): void {
    const t = e.currentTarget as HTMLTextAreaElement
    oninput(t.value)
    refresh(t.value, t.selectionStart ?? t.value.length)
  }

  function pick(s: Suggestion): void {
    if (anchor === null || !el) return
    const caret = el.selectionStart ?? value.length
    const next = `${value.slice(0, anchor)}@${s.slug} ${value.slice(caret)}`
    const pos = anchor + s.slug.length + 2
    oninput(next)
    anchor = null
    // Caret dipulihkan setelah Svelte menulis ulang value; tanpa ini ia
    // melompat ke akhir dan sebutan berikutnya diketik di tempat yang salah.
    queueMicrotask(() => {
      if (!el) return
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  function onKeydown(e: KeyboardEvent): void {
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        active = (active + 1) % matches.length
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        active = (active - 1 + matches.length) % matches.length
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick(matches[active]!)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        anchor = null
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onsubmit()
    }
  }
</script>

<div class="composer">
  {#if open}
    <div class="menu">
      {#each matches as s, i (s.slug)}
        <button
          class="item"
          class:active={i === active}
          class:off={!s.online}
          onmousedown={(e) => {
            // mousedown, bukan click: blur duluan menutup menu sebelum klik jadi.
            e.preventDefault()
            pick(s)
          }}
        >
          <span class="slug">@{s.slug}</span>
          <span class="label">{s.label}</span>
          {#if s.note}<span class="note">{s.note}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}

  <textarea
    bind:this={el}
    {value}
    {disabled}
    {placeholder}
    rows="2"
    oninput={onInputEvent}
    onkeydown={onKeydown}
    onclick={(e) => refresh(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
    onblur={() => (anchor = null)}
  ></textarea>
  <button type="button" onclick={onsubmit} disabled={disabled || !value.trim()}>Kirim</button>
</div>

<style>
  .composer {
    position: relative;
    display: flex;
    gap: 8px;
    padding: 12px 16px 14px;
    border-top: 1px solid #23272f;
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
  .composer > button {
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
  .composer > button:disabled {
    background: #2b2f38;
    color: #6b7280;
    cursor: default;
  }
  .menu {
    position: absolute;
    left: 16px;
    right: 16px;
    bottom: calc(100% - 6px);
    max-height: 220px;
    overflow-y: auto;
    background: #14171c;
    border: 1px solid #2b303a;
    border-radius: 8px;
    padding: 4px;
    box-shadow: 0 10px 30px #0009;
    z-index: 5;
  }
  .item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    background: none;
    border: none;
    color: #c9d1d9;
    font: inherit;
    font-size: 13px;
    text-align: left;
    padding: 6px 9px;
    border-radius: 5px;
    cursor: pointer;
  }
  .item.active,
  .item:hover {
    background: #1f2937;
  }
  .item.off {
    color: #6b7280;
  }
  .slug {
    color: #a78bfa;
    font-family: ui-monospace, monospace;
    font-size: 12px;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note {
    margin-left: auto;
    font-size: 11px;
    color: #4b515c;
    flex: none;
  }

  @media (max-width: 768px) {
    .composer {
      padding: 10px 12px;
    }
    textarea {
      font-size: 14px;
      padding: 10px 12px;
    }
  }
</style>
