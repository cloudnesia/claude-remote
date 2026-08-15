<script lang="ts">
  import type { Block } from '@company/protocol'
  import { resultText, toolView } from './tool-view.ts'
  import ToolIcon from './ToolIcon.svelte'

  let {
    block,
    compact = false,
  }: { block: Block & { kind: 'tool' }; compact?: boolean } = $props()

  /** Batas sebelum isi dilipat. Cukup untuk melihat konteks, tidak menenggelamkan. */
  const FOLD_INPUT = 16
  const FOLD_RESULT = 12

  let openInput = $state(false)
  let openResult = $state(false)
  let copied = $state(false)

  // Selama masih di-stream, `input` berupa JSON parsial yang belum bisa
  // di-parse — jadi ia ditampilkan mentah, bukan dipaksa lewat toolView().
  const streaming = $derived(!block.done && typeof block.input === 'string')
  const view = $derived(streaming ? null : toolView(block.name, block.input))
  const body = $derived(view?.body ?? null)

  const bodyText = $derived(
    body?.kind === 'diff'
      ? `${body.before}\n${body.after}`
      : body && 'text' in body
        ? body.text
        : '',
  )

  const lines = (s: string) => (s ? s.split('\n') : [])
  const clamp = (s: string, max: number, open: boolean) => {
    const all = lines(s)
    return open ? all : all.slice(0, max)
  }
  const hidden = (s: string, max: number, open: boolean) =>
    open ? 0 : Math.max(0, lines(s).length - max)

  const result = $derived(block.result ? resultText(block.result.content) : '')

  /** Yang disalin: perintah atau isi berkas — bukan pembungkus JSON-nya. */
  const copyable = $derived(bodyText || view?.target || '')

  async function copy() {
    try {
      await navigator.clipboard.writeText(copyable)
      copied = true
      setTimeout(() => (copied = false), 1200)
    } catch {
      /* clipboard ditolak browser; tidak ada yang bisa dilakukan */
    }
  }
</script>

<div class="tool" class:running={!block.result} class:compact>
  <div class="head">
    <span class="icon"><ToolIcon name={block.name} /></span>
    <span class="name">{block.name}</span>
    {#if view?.target}
      <span class="target" title={view.target}>{view.target}</span>
    {/if}
    {#if view?.note}
      <span class="note">{view.note}</span>
    {/if}
    <span class="spacer"></span>
    <!-- Di panel approval (compact) tool BELUM jalan — ia sedang ditahan
         menunggu keputusan. "berjalan…" di situ akan berbohong. -->
    {#if !block.done}
      <span class="hint">menyusun…</span>
    {:else if !block.result && !compact}
      <span class="hint live">berjalan…</span>
    {:else if block.result && !block.result.ok}
      <span class="hint bad">gagal</span>
    {/if}
    {#if copyable}
      <button class="copy" onclick={copy} title="Salin">{copied ? '✓' : '⧉'}</button>
    {/if}
  </div>

  {#if streaming}
    <pre class="raw">{block.input}</pre>
  {:else if body?.kind === 'shell'}
    <div class="shell">
      {#each clamp(body.text, FOLD_INPUT, openInput) as line, i (i)}
        <div class="ln"><span class="prompt">{i === 0 ? '$' : ' '}</span>{line}</div>
      {/each}
    </div>
  {:else if body?.kind === 'diff'}
    <div class="diff">
      {#each clamp(body.before, FOLD_INPUT, openInput) as line, i (i)}
        <div class="ln del"><span class="sign">−</span>{line}</div>
      {/each}
      {#each clamp(body.after, FOLD_INPUT, openInput) as line, i (i)}
        <div class="ln add"><span class="sign">+</span>{line}</div>
      {/each}
    </div>
  {:else if body?.kind === 'todo'}
    <ul class="todo">
      {#each body.items as t (t.text)}
        <li class={t.status}>
          <span class="mark">
            {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'}
          </span>
          {t.text}
        </li>
      {/each}
    </ul>
  {:else if body}
    <div class="code" class:json={body.kind === 'json'}>
      {#if body.kind === 'code' && body.lang}
        <div class="lang">{body.lang}</div>
      {/if}
      {#each clamp(bodyText, FOLD_INPUT, openInput) as line, i (i)}
        <div class="ln"><span class="num">{i + 1}</span>{line}</div>
      {/each}
    </div>
  {/if}

  {#if hidden(bodyText, FOLD_INPUT, openInput) > 0}
    <button class="more" onclick={() => (openInput = true)}>
      tampilkan {hidden(bodyText, FOLD_INPUT, openInput)} baris lagi
    </button>
  {:else if openInput && lines(bodyText).length > FOLD_INPUT}
    <button class="more" onclick={() => (openInput = false)}>lipat lagi</button>
  {/if}

  {#if block.result}
    {#if result.trim()}
      <div class="result" class:err={!block.result.ok}>
        {#each clamp(result, FOLD_RESULT, openResult) as line, i (i)}
          <div class="ln">{line}</div>
        {/each}
      </div>
      {#if hidden(result, FOLD_RESULT, openResult) > 0}
        <button class="more" onclick={() => (openResult = true)}>
          tampilkan {hidden(result, FOLD_RESULT, openResult)} baris lagi
        </button>
      {:else if openResult}
        <button class="more" onclick={() => (openResult = false)}>lipat lagi</button>
      {/if}
    {:else}
      <div class="result empty">selesai, tanpa keluaran</div>
    {/if}
  {/if}
</div>

<style>
  .tool {
    border: 1px solid #23272f;
    border-radius: 7px;
    margin-bottom: 10px;
    overflow: hidden;
    background: #101318;
  }
  .tool.running {
    border-color: #2f4a6b;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 10px;
    background: #1b1f26;
    font-size: 12px;
    min-width: 0;
  }
  .icon {
    display: inline-flex;
    align-items: center;
    color: #4a9eff;
    flex: none;
  }
  .name {
    font-weight: 600;
    color: #4a9eff;
    flex: none;
  }
  .target {
    font-family: ui-monospace, monospace;
    color: #c9d1d9;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .note {
    color: #6b7280;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .spacer {
    flex: 1;
  }
  .hint {
    font-size: 11px;
    color: #6b7280;
    flex: none;
  }
  .hint.live {
    color: #4a9eff;
  }
  .hint.bad {
    color: #e5534b;
  }
  .copy {
    background: none;
    border: none;
    color: #4b515c;
    cursor: pointer;
    font-size: 12px;
    padding: 0 2px;
    flex: none;
    line-height: 1;
  }
  .copy:hover {
    color: #c9d1d9;
  }

  /* Semua badan tool memakai grid baris yang sama supaya tinggi barisnya
     konsisten antar jenis — shell, kode, diff, dan hasil. */
  .ln {
    display: flex;
    gap: 8px;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    padding: 0 10px;
  }
  .shell,
  .code,
  .diff,
  .result {
    padding: 7px 0;
  }
  .shell .prompt {
    color: #3fb950;
    flex: none;
    user-select: none;
  }
  .shell .ln {
    color: #d7dce3;
  }
  .code .ln {
    color: #9aa3b2;
  }
  .code .num {
    flex: none;
    width: 2ch;
    text-align: right;
    color: #3a3f4a;
    user-select: none;
  }
  .code.json .ln {
    color: #8fa6bd;
  }
  .lang {
    padding: 0 10px 4px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: #4b515c;
  }
  .diff .sign {
    flex: none;
    width: 1ch;
    user-select: none;
  }
  .diff .del {
    background: #2a1618;
    color: #e39b97;
  }
  .diff .add {
    background: #12241a;
    color: #8fd7a4;
  }
  .result {
    border-top: 1px solid #23272f;
    color: #7d8798;
    max-height: 340px;
    overflow-y: auto;
  }
  .result.err {
    color: #e5934b;
  }
  .result.empty {
    padding: 6px 10px;
    font-size: 11px;
    font-style: italic;
    color: #4b515c;
  }
  .raw {
    margin: 0;
    padding: 8px 10px;
    font-size: 12px;
    line-height: 1.5;
    color: #6b7280;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .todo {
    margin: 0;
    padding: 8px 12px;
    list-style: none;
    font-size: 12px;
  }
  .todo li {
    display: flex;
    gap: 8px;
    line-height: 1.7;
    color: #9aa3b2;
  }
  .todo li.completed {
    color: #4b515c;
    text-decoration: line-through;
  }
  .todo li.in_progress {
    color: #e6e9ef;
  }
  .todo .mark {
    flex: none;
    color: #4a9eff;
  }
  .more {
    display: block;
    width: 100%;
    background: #161a20;
    border: none;
    border-top: 1px solid #23272f;
    color: #6b7280;
    font: inherit;
    font-size: 11px;
    padding: 5px 10px;
    text-align: left;
    cursor: pointer;
  }
  .more:hover {
    color: #4a9eff;
  }

  /* Dipakai di panel approval, yang ruangnya jauh lebih sempit. */
  .tool.compact .ln {
    font-size: 11px;
    line-height: 1.5;
  }
  .tool.compact .result {
    max-height: 140px;
  }
</style>
