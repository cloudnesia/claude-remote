<script lang="ts">
  import type { Answers, AskQuestion } from '@company/protocol'

  let {
    questions,
    onSubmit,
    onSkip,
  }: {
    questions: AskQuestion[]
    onSubmit: (answers: Answers) => void
    onSkip: () => void
  } = $props()

  // Satu array label per pertanyaan. Single-select tinggal array berisi satu —
  // menyatukan keduanya menghindari dua cabang state yang harus disinkronkan.
  let picked = $state<string[][]>(questions.map(() => []))
  let other = $state<string[]>(questions.map(() => ''))

  /** Bentuk jawaban yang diminta Claude Code: satu string, multi digabung koma. */
  function answerOf(i: number): string {
    const custom = other[i]?.trim() ?? ''
    const labels = picked[i] ?? []
    return (custom ? [...labels, custom] : labels).join(', ')
  }

  const ready = $derived(questions.every((_, i) => answerOf(i) !== ''))

  function toggle(i: number, q: AskQuestion, label: string) {
    const cur = picked[i] ?? []
    if (q.multiSelect) {
      picked[i] = cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]
      return
    }
    picked[i] = cur.includes(label) ? [] : [label]
    // Single-select: memilih opsi berarti membatalkan jawaban bebas.
    if (picked[i].length) other[i] = ''
  }

  function onOther(i: number, q: AskQuestion, value: string) {
    other[i] = value
    if (!q.multiSelect && value.trim()) picked[i] = []
  }

  function submit(e: Event) {
    e.preventDefault()
    if (!ready) return
    const answers: Answers = {}
    questions.forEach((q, i) => (answers[q.question] = answerOf(i)))
    onSubmit(answers)
  }
</script>

<form class="ask" onsubmit={submit}>
  <div class="lead">Claude bertanya</div>

  {#each questions as q, i (q.question)}
    <div class="q">
      <div class="qhead">
        {#if q.header}<span class="chip">{q.header}</span>{/if}
        <span class="qtext">{q.question}</span>
        {#if q.multiSelect}<span class="multi">boleh lebih dari satu</span>{/if}
      </div>

      <div class="opts">
        {#each q.options as o (o.label)}
          <button
            type="button"
            class="opt"
            class:on={picked[i]?.includes(o.label)}
            onclick={() => toggle(i, q, o.label)}
          >
            <span class="label">{o.label}</span>
            {#if o.description}<span class="desc">{o.description}</span>{/if}
          </button>
        {/each}
      </div>

      <input
        class="other"
        value={other[i] ?? ''}
        oninput={(e) => onOther(i, q, e.currentTarget.value)}
        placeholder="Jawaban lain…"
      />
    </div>
  {/each}

  <div class="acts">
    <button type="button" class="skip" onclick={onSkip}>Lewati</button>
    <button type="submit" class="send" disabled={!ready}>Kirim jawaban</button>
  </div>
</form>

<style>
  .ask {
    margin: 10px 16px 0;
    padding: 12px 14px;
    background: #14202e;
    border: 1px solid #2f4a6b;
    border-radius: 7px;
    font-size: 13px;
  }
  .lead {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #4a9eff;
    margin-bottom: 10px;
  }
  .q + .q {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid #23303f;
  }
  .qhead {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 7px;
    margin-bottom: 8px;
  }
  .chip {
    flex: none;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #9aa3b2;
    background: #1f2a38;
    border: 1px solid #2f4a6b;
    border-radius: 4px;
    padding: 1px 6px;
  }
  .qtext {
    line-height: 1.5;
  }
  .multi {
    font-size: 11px;
    color: #6b7280;
  }
  .opts {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .opt {
    display: block;
    width: 100%;
    text-align: left;
    background: #1a1f27;
    border: 1px solid #2b323d;
    border-radius: 6px;
    padding: 7px 10px;
    font: inherit;
    color: #c9d1d9;
    cursor: pointer;
  }
  .opt:hover {
    border-color: #3a4759;
  }
  .opt.on {
    background: #17324f;
    border-color: #4a9eff;
  }
  .label {
    display: block;
    font-size: 13px;
  }
  .desc {
    display: block;
    margin-top: 2px;
    font-size: 11px;
    line-height: 1.45;
    color: #7d8798;
  }
  .other {
    display: block;
    width: 100%;
    margin-top: 8px;
    background: #14171c;
    border: 1px solid #23272f;
    border-radius: 6px;
    color: inherit;
    font: inherit;
    font-size: 12px;
    padding: 7px 10px;
  }
  .other:focus {
    outline: none;
    border-color: #3a4759;
  }
  .acts {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 12px;
  }
  .acts button {
    border-radius: 5px;
    padding: 6px 13px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .send {
    background: #2563eb;
    color: #fff;
    font-weight: 600;
  }
  .send:disabled {
    background: #2b2f38;
    color: #6b7280;
    cursor: default;
  }
  .skip {
    background: none;
    border-color: #2f4a6b;
    color: #7d8798;
  }

  @media (max-width: 768px) {
    .ask {
      margin: 8px 12px 0;
      padding: 10px 12px;
    }
    .acts button {
      flex: 1;
      padding: 9px 13px;
      font-size: 13px;
    }
    .other {
      font-size: 13px;
    }
  }
</style>
