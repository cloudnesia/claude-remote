<script lang="ts">
  import { store } from '$lib/store.svelte.ts'
  import Sidebar from '$lib/Sidebar.svelte'
  import Pane from '$lib/Pane.svelte'
  import GeneralPane from '$lib/GeneralPane.svelte'
  import PairDialog from '$lib/PairDialog.svelte'
  import NewSessionDialog from '$lib/NewSessionDialog.svelte'
  import GatewayDialog from '$lib/GatewayDialog.svelte'
  import type { HostMeta } from '@company/protocol'

  let tokenInput = $state('')
  let token = $state<string | null>(null)
  let pairing = $state(false)
  let newFor = $state<HostMeta | null>(null)
  let gatewayFor = $state<HostMeta | null>(null)

  $effect(() => {
    // Token dev: dari ?token= sekali, lalu disimpan. Login user sungguhan
    // (password/OAuth) belum ada — ini satu-satunya bagian auth yang tersisa.
    const url = new URL(location.href)
    const fromUrl = url.searchParams.get('token')
    const t = fromUrl ?? localStorage.getItem('token')
    if (fromUrl) {
      localStorage.setItem('token', fromUrl)
      url.searchParams.delete('token')
      history.replaceState(null, '', url)
    }
    if (t && !token) {
      token = t
      store.connect(t)
    }
  })

  // Token ditolak hub → balik ke layar masuk, jangan diam dengan sidebar kosong.
  $effect(() => {
    if (store.authError) token = null
  })

  function signIn(e: Event) {
    e.preventDefault()
    const t = tokenInput.trim()
    if (!t) return
    localStorage.setItem('token', t)
    token = t
    store.connect(t)
  }
</script>

{#if !token}
  <div class="login">
    <form onsubmit={signIn}>
      <h1>Masuk</h1>
      {#if store.authError}
        <div class="autherr">{store.authError}</div>
      {/if}
      <p>Tempel user token dari <code>npm run seed</code>.</p>
      <input bind:value={tokenInput} placeholder="usr_…" />
      <button type="submit">Masuk</button>
    </form>
  </div>
{:else}
  <div class="app">
    <Sidebar
      onpair={() => (pairing = true)}
      onnew={(h) => (newFor = h)}
      ongateway={(h) => (gatewayFor = h)}
    />

    <main>
      {#if store.open.length === 0}
        <div class="blank">
          Pilih session di kiri.
          <span class="tip">Arahkan kursor ke session lain lalu klik ⊞ untuk membukanya berdampingan.</span>
        </div>
      {:else}
        {#each store.open as id (id)}
          {#if store.isGeneral(id)}
            <GeneralPane sessionId={id} closable={store.open.length > 1} />
          {:else}
            <Pane sessionId={id} closable={store.open.length > 1} />
          {/if}
        {/each}
      {/if}
    </main>
  </div>

  {#if pairing}
    <PairDialog onclose={() => (pairing = false)} />
  {/if}

  {#if newFor}
    <NewSessionDialog host={newFor} onclose={() => (newFor = null)} />
  {/if}

  {#if gatewayFor}
    <GatewayDialog host={gatewayFor} onclose={() => (gatewayFor = null)} />
  {/if}

  {#if store.notice}
    <div class="toast">{store.notice}</div>
  {/if}
{/if}

<style>
  :global(body) {
    margin: 0;
    background: #0f1115;
    color: #e6e9ef;
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  :global(*) {
    box-sizing: border-box;
  }
  .app {
    display: flex;
    height: 100vh;
  }
  main {
    flex: 1;
    display: flex;
    min-width: 0;
  }
  .blank {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: #4b515c;
  }
  .tip {
    font-size: 12px;
    color: #3a3f4a;
  }
  .login {
    display: grid;
    place-items: center;
    height: 100vh;
  }
  .login form {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 320px;
  }
  .login h1 {
    margin: 0;
    font-size: 20px;
  }
  .login p {
    margin: 0;
    color: #6b7280;
    font-size: 13px;
  }
  .login code {
    background: #1f242c;
    padding: 1px 5px;
    border-radius: 4px;
  }
  .login input,
  .login button {
    padding: 9px 12px;
    border-radius: 7px;
    font: inherit;
  }
  .login input {
    background: #14171c;
    border: 1px solid #23272f;
    color: inherit;
  }
  .login button {
    background: #2563eb;
    border: none;
    color: #fff;
    cursor: pointer;
  }
  .autherr {
    background: #4a1f1c;
    border: 1px solid #e5534b;
    color: #ffb3ae;
    padding: 9px 12px;
    border-radius: 7px;
    font-size: 13px;
  }
  .toast {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #4a1f1c;
    border: 1px solid #e5534b;
    color: #ffb3ae;
    padding: 9px 16px;
    border-radius: 7px;
    font-size: 13px;
    z-index: 10;
  }

  /* Mobile responsive design */
  @media (max-width: 768px) {
    .app {
      flex-direction: column;
    }
    main {
      height: calc(100vh - 60px);
    }
    .blank {
      font-size: 13px;
      padding: 0 20px;
      text-align: center;
    }
    .tip {
      font-size: 11px;
    }
    .login form {
      width: 90%;
      max-width: 320px;
      padding: 0 20px;
    }
    .toast {
      left: 10px;
      right: 10px;
      transform: none;
      max-width: calc(100vw - 20px);
    }
  }

  /* Touch devices - larger tap targets */
  @media (pointer: coarse) {
    :global(button), :global(a), :global(input), :global(select) {
      min-height: 44px;
      min-width: 44px;
    }
  }
</style>
