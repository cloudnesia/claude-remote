<script lang="ts">
  import { store } from './store.svelte.ts'

  let { onclose }: { onclose: () => void } = $props()

  let code = $state('')
  let busy = $state(false)
  let error = $state('')
  let done = $state('')

  async function submit(e: Event) {
    e.preventDefault()
    if (!code.trim() || busy) return
    busy = true
    error = ''
    const r = await store.claimHost(code.trim())
    busy = false
    if (r.ok) {
      done = r.message
      setTimeout(onclose, 1400)
    } else {
      error = r.message
    }
  }
</script>

<div
  class="backdrop"
  role="button"
  tabindex="-1"
  onclick={onclose}
  onkeydown={(e) => e.key === 'Escape' && onclose()}
></div>

<div class="modal">
  {#if done}
    <h2>Berhasil</h2>
    <p>{done}</p>
  {:else}
    <h2>Hubungkan laptop</h2>
    <p>
      Di laptop yang mau dihubungkan, jalankan <code>company-agent login</code>, lalu
      ketik kode yang muncul di sana.
    </p>
    <form onsubmit={submit}>
      <input
        bind:value={code}
        placeholder="XXXX-XXXX"
        maxlength="9"
        autocomplete="off"
        spellcheck="false"
      />
      {#if error}<div class="err">{error}</div>{/if}
      <div class="acts">
        <button type="button" class="ghost" onclick={onclose}>Batal</button>
        <button type="submit" disabled={busy || !code.trim()}>
          {busy ? 'Menghubungkan…' : 'Hubungkan'}
        </button>
      </div>
    </form>
    <p class="warn">
      Laptop yang terhubung bisa menjalankan perintah atas perintahmu. Hubungkan
      hanya mesin milikmu sendiri.
    </p>
  {/if}
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
    width: 380px;
    background: #14171c;
    border: 1px solid #2b303a;
    border-radius: 10px;
    padding: 22px;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 17px;
  }
  p {
    margin: 0 0 16px;
    color: #9aa3b2;
    font-size: 13px;
    line-height: 1.55;
  }
  code {
    background: #1f242c;
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 12px;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  input {
    background: #0f1115;
    border: 1px solid #2b303a;
    border-radius: 7px;
    color: inherit;
    padding: 11px 14px;
    font: inherit;
    font-family: ui-monospace, monospace;
    font-size: 19px;
    letter-spacing: 0.14em;
    text-align: center;
    text-transform: uppercase;
  }
  input:focus {
    outline: none;
    border-color: #3a4759;
  }
  .err {
    color: #e5534b;
    font-size: 13px;
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
    background: #2563eb;
    color: #fff;
  }
  .acts button:disabled {
    background: #2b2f38;
    color: #6b7280;
    cursor: default;
  }
  .ghost {
    background: none !important;
    border-color: #2b303a !important;
    color: #9aa3b2 !important;
  }
  .warn {
    margin: 16px 0 0;
    font-size: 12px;
    color: #6b7280;
  }
</style>
