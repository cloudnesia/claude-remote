<script lang="ts">
  import { store } from '$lib/store.svelte.ts'
  import Sidebar from '$lib/Sidebar.svelte'
  import TabBar from '$lib/TabBar.svelte'
  import Pane from '$lib/Pane.svelte'
  import GeneralPane from '$lib/GeneralPane.svelte'
  import PairDialog from '$lib/PairDialog.svelte'
  import NewSessionDialog from '$lib/NewSessionDialog.svelte'
  import GatewayDialog from '$lib/GatewayDialog.svelte'
  import YoutubeShortPane from '$lib/YoutubeShortPane.svelte'
  import type { HostMeta } from '@company/protocol'

  let tokenInput = $state('')
  let token = $state<string | null>(null)
  let pairing = $state(false)
  let newFor = $state<HostMeta | null>(null)
  let gatewayFor = $state<HostMeta | null>(null)
  /** Drawer sidebar di mobile — tidak berpengaruh apa-apa di desktop (lihat
   * @media di Sidebar.svelte), sidebar di sana selalu terlihat seperti biasa. */
  let mobileSidebarOpen = $state(false)

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
      open={mobileSidebarOpen}
      onclose={() => (mobileSidebarOpen = false)}
    />

    <main>
      <!-- Cuma tampil di mobile (lihat @media) — sidebar sekarang drawer
           tersembunyi di sana, jadi butuh pemicu yang selalu kelihatan
           terlepas dari tab mana pun yang sedang aktif. -->
      <button
        class="mobile-sidebar-toggle"
        onclick={() => (mobileSidebarOpen = true)}
        aria-label="Buka daftar node & session"
      >
        ☰ <span>Node & session</span>
      </button>

      {#if store.experimental === 'youtube-short'}
        <!-- Panel eksperimental MENGGANTIKAN tab session sementara — tab
             yang lagi terbuka tidak ditutup, cuma tidak dirender selagi
             ini tampil. Nutup panel ini balik ke tab yang aktif sebelumnya. -->
        <YoutubeShortPane onclose={() => (store.experimental = null)} />
      {:else if store.open.length === 0}
        <div class="blank">
          Pilih session di kiri.
          <span class="tip">Klik session lain kapan saja — terbuka sebagai tab baru, yang lama tidak tertutup.</span>
        </div>
      {:else}
        <TabBar />
        {#if store.active}
          {#if store.isGeneral(store.active)}
            <GeneralPane sessionId={store.active} />
          {:else}
            <Pane sessionId={store.active} />
          {/if}
        {/if}
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
  :global(html, body) {
    height: 100%;
    /* Shell aplikasi selalu pas satu viewport — tiap panel (transcript,
       sidebar, dst) yang scroll sendiri lewat overflow-y internalnya
       masing-masing. Tanpa ini, komponen yang salah hitung tinggi (lupa
       min-height: 0 di rantai flex) bikin SELURUH halaman yang scroll,
       menyeret header/tab bar/sidebar ikut hilang dari layar. */
    overflow: hidden;
  }
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
    /* Browser mobile (terutama Safari iOS) menghitung 100vh dari viewport
       TERBESAR yang mungkin — seolah address bar sudah disembunyikan —
       bukan tinggi yang benar-benar terlihat saat itu. `.app` jadi lebih
       tinggi dari layar sungguhan, dan gabungan itu dengan `overflow: hidden`
       di body (lihat komentar di atas) membuat bagian bawah (sidebar/chat)
       terpotong tak terlihat, tanpa cara scroll ke sana. `100dvh` mengikuti
       tinggi viewport yang benar-benar tampak; browser yang belum kenal unit
       ini otomatis abaikan baris ini dan pakai 100vh di atasnya. */
    height: 100dvh;
  }
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
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
  /* Cuma kelihatan di mobile (lihat @media) — sidebar di sana jadi drawer
     tersembunyi, jadi butuh pemicu yang selalu ada di area chat. */
  .mobile-sidebar-toggle {
    display: none;
  }
  .tip {
    font-size: 12px;
    color: #3a3f4a;
  }
  .login {
    display: grid;
    place-items: center;
    height: 100vh;
    height: 100dvh;
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
    /* SEBELUMNYA main dipaksa `height: calc(100vh - 60px)` — angka 60px itu
       tidak pernah cocok dengan tinggi sidebar mobile yang sebenarnya
       (aside di bawah di-cap `max-height: 200px`, lihat Sidebar.svelte).
       Selisihnya bikin main "meluber" di luar viewport; dulu masih bisa
       di-scroll-page untuk melihatnya, tapi sejak body dikunci
       `overflow: hidden` (lihat komentar di atas), bagian yang meluber itu
       jadi benar-benar tidak terlihat DAN tidak bisa dicapai sama sekali —
       persis laporan "sidebar hilang, chat area juga tidak kelihatan".
       Biarkan flexbox yang menghitung (flex: 1; min-height: 0 di aturan
       dasar main) — sisa tinggi setelah aside, berapa pun tingginya. */
    .blank {
      font-size: 13px;
      padding: 0 20px;
      text-align: center;
    }
    .tip {
      font-size: 11px;
    }
    .mobile-sidebar-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: none;
      width: 100%;
      padding: 10px 14px;
      background: #14171c;
      border: none;
      border-bottom: 1px solid #23272f;
      color: #9aa3b2;
      font: inherit;
      font-size: 13px;
      text-align: left;
      cursor: pointer;
    }
    .mobile-sidebar-toggle:active {
      background: #1b1f26;
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
