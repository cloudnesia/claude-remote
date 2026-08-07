<script lang="ts">
  import { store } from './store.svelte.ts'
  import type { HostMeta } from '@company/protocol'

  let { host, onclose }: { host: HostMeta; onclose: () => void } = $props()

  const OPENROUTER = 'https://openrouter.ai/api'

  let baseUrl = $state(host.gateway ?? OPENROUTER)
  let apiKey = $state('')
  let error = $state('')

  /** Kunci tidak pernah dikirim balik ke browser, jadi tidak ada yang bisa
   * ditampilkan di sini — mengganti gateway selalu berarti mengetik ulang. */
  const configured = !!host.gateway

  function submit(e: Event) {
    e.preventDefault()
    const url = baseUrl.trim()
    if (!/^https?:\/\/\S+$/i.test(url)) {
      error = 'Base URL harus diawali http:// atau https://'
      return
    }
    if (!apiKey.trim()) {
      error = 'API key masih kosong'
      return
    }
    store.setGateway(host.id, url, apiKey.trim())
    onclose()
  }

  function clear() {
    store.clearGateway(host.id)
    onclose()
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
  <h2>Gateway untuk {host.name}</h2>
  <p>
    Claude Code di laptop itu diarahkan ke endpoint lain, bukan login Claude
    miliknya. Untuk OpenRouter, base URL berhenti di <code>/api</code> — Claude
    Code yang menambahkan <code>/v1/messages</code>.
  </p>

  {#if configured}
    <div class="cur">
      Sekarang: <strong>{host.gateway}</strong>
    </div>
  {/if}

  <form onsubmit={submit}>
    <label>
      <span>Base URL</span>
      <input bind:value={baseUrl} placeholder={OPENROUTER} autocomplete="off" spellcheck="false" />
    </label>
    <label>
      <span>API key</span>
      <input
        bind:value={apiKey}
        type="password"
        placeholder={configured ? 'ketik ulang untuk mengganti' : 'sk-or-v1-…'}
        autocomplete="off"
        spellcheck="false"
      />
    </label>

    {#if error}<div class="err">{error}</div>{/if}

    <div class="acts">
      {#if configured}
        <button type="button" class="danger" onclick={clear}>Lepas gateway</button>
      {/if}
      <button type="button" class="ghost" onclick={onclose}>Batal</button>
      <button type="submit">Simpan</button>
    </div>
  </form>

  <p class="warn">
    Kunci ini melewati hub sekali untuk sampai ke laptop, lalu disimpan di sana
    (mode <code>0600</code>) — hub tidak menyimpannya dan tidak bisa
    menampilkannya lagi. Pakai hub yang kamu percaya dan koneksi HTTPS. Session
    yang sedang jalan di node ini akan dimatikan lalu dilanjutkan lewat endpoint
    baru, dan penagihannya pindah ke penyedia gateway.
  </p>
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
    width: 420px;
    max-width: calc(100vw - 24px);
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
  .cur {
    background: #1f242c;
    border: 1px solid #2b303a;
    border-radius: 7px;
    padding: 8px 12px;
    margin-bottom: 14px;
    font-size: 12px;
    color: #9aa3b2;
    overflow-wrap: anywhere;
  }
  .cur strong {
    color: #e6e9ef;
    font-weight: 600;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  label span {
    font-size: 12px;
    color: #9aa3b2;
  }
  input {
    background: #0f1115;
    border: 1px solid #2b303a;
    border-radius: 7px;
    color: inherit;
    padding: 10px 12px;
    font: inherit;
    font-family: ui-monospace, monospace;
    font-size: 13px;
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
  .ghost {
    background: none !important;
    border-color: #2b303a !important;
    color: #9aa3b2 !important;
  }
  .danger {
    background: none !important;
    border-color: #e5534b !important;
    color: #e5534b !important;
    margin-right: auto;
  }
  .warn {
    margin: 16px 0 0;
    font-size: 12px;
    color: #6b7280;
  }
</style>
