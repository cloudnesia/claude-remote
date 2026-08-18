<script lang="ts">
  let { onclose }: { onclose: () => void } = $props()

  /**
   * Belum ada API resmi buat "feed shorts acak" yang bisa di-embed gratis —
   * ini cuma pemutar video biasa dikunci rasio vertikal 9:16. Tiga ID di
   * bawah sengaja video yang PASTI tidak akan pernah dihapus/pindah (umurnya
   * puluhan tahun, jutaan/miliaran views, kanal resmi) — dipakai sebagai
   * contoh awal sebelum user tempel link Shorts sungguhan miliknya sendiri.
   */
  const SEED_IDS = [
    'dQw4w9WgXcQ', // Rick Astley — Never Gonna Give You Up
    '9bZkp7q19f0', // PSY — Gangnam Style
    'jNQXAC9IVRw', // "Me at the zoo" — video pertama di YouTube
  ]

  let currentId = $state(SEED_IDS[Math.floor(Math.random() * SEED_IDS.length)]!)
  let urlInput = $state('')
  let error = $state('')

  /** Terima link video/shorts/embed YouTube, atau video ID mentah (11 karakter). */
  function extractId(input: string): string | null {
    const trimmed = input.trim()
    if (!trimmed) return null
    if (/^[\w-]{11}$/.test(trimmed)) return trimmed
    try {
      const u = new URL(trimmed)
      if (u.hostname === 'youtu.be') return u.pathname.slice(1) || null
      if (u.hostname.endsWith('youtube.com')) {
        const shorts = u.pathname.match(/\/shorts\/([\w-]{11})/)
        if (shorts) return shorts[1]!
        const v = u.searchParams.get('v')
        if (v) return v
        const embed = u.pathname.match(/\/embed\/([\w-]{11})/)
        if (embed) return embed[1]!
      }
    } catch {
      /* bukan URL valid — bukan error, mungkin memang cuma teks acak */
    }
    return null
  }

  function load(e: Event) {
    e.preventDefault()
    const id = extractId(urlInput)
    if (!id) {
      error = 'Link tidak dikenali — tempel link video/Shorts YouTube, atau video ID-nya langsung.'
      return
    }
    error = ''
    currentId = id
    urlInput = ''
  }

  function shuffle() {
    let next = currentId
    while (next === currentId) next = SEED_IDS[Math.floor(Math.random() * SEED_IDS.length)]!
    currentId = next
  }
</script>

<section>
  <header>
    <div class="title">
      <span class="kind">experimental</span>
      YouTube Short
    </div>
    <button class="icon" onclick={onclose} title="Tutup">✕</button>
  </header>

  <div class="body">
    <div class="player">
      {#key currentId}
        <iframe
          src={`https://www.youtube.com/embed/${currentId}?autoplay=1&mute=1&loop=1&playlist=${currentId}`}
          title="YouTube short"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen
        ></iframe>
      {/key}
    </div>

    <form class="loader" onsubmit={load}>
      <input
        bind:value={urlInput}
        placeholder="Tempel link YouTube Shorts…"
        autocomplete="off"
        spellcheck="false"
      />
      <button type="submit">Muat</button>
      <button type="button" class="ghost" onclick={shuffle}>🔀 Acak</button>
    </form>
    {#if error}<div class="err">{error}</div>{/if}
    <p class="hint">
      Fitur iseng — belum ada feed shorts sungguhan, cuma pemutar video biasa
      yang dikunci rasio vertikal. Tempel link Shorts kamu sendiri di atas.
    </p>
  </div>
</section>

<style>
  section {
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    padding: 11px 16px;
    border-bottom: 1px solid #23272f;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 7px;
    font-weight: 600;
    font-size: 14px;
  }
  .kind {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #ff6b6b;
    border: 1px solid #7a3f3f;
    background: #3a1f1f;
    border-radius: 3px;
    padding: 1px 5px;
    flex: none;
  }
  .icon {
    background: #2b2f38;
    border: 1px solid #3a3f4a;
    color: #c9d1d9;
    border-radius: 5px;
    width: 28px;
    height: 28px;
    line-height: 1;
    font-size: 14px;
    cursor: pointer;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .icon:hover {
    color: #fff;
    border-color: #4a9eff;
    background: #3a4759;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 24px;
    overflow-y: auto;
  }
  .player {
    position: relative;
    width: min(360px, 100%);
    aspect-ratio: 9 / 16;
    background: #000;
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 10px 34px rgba(0, 0, 0, 0.45);
    flex: none;
  }
  .player iframe {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: none;
  }
  .loader {
    display: flex;
    gap: 8px;
    width: 100%;
    max-width: 420px;
  }
  .loader input {
    flex: 1;
    min-width: 0;
    background: #14171c;
    border: 1px solid #23272f;
    border-radius: 7px;
    color: inherit;
    font: inherit;
    font-size: 13px;
    padding: 8px 11px;
  }
  .loader input:focus {
    outline: none;
    border-color: #3a4759;
  }
  .loader button {
    border-radius: 7px;
    padding: 8px 14px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid transparent;
    background: #2563eb;
    color: #fff;
    white-space: nowrap;
    flex: none;
  }
  .loader .ghost {
    background: none;
    border-color: #2b303a;
    color: #9aa3b2;
  }
  .err {
    color: #e5534b;
    font-size: 12px;
    text-align: center;
  }
  .hint {
    color: #4b515c;
    font-size: 11px;
    text-align: center;
    max-width: 380px;
    margin: 0;
  }

  @media (max-width: 768px) {
    header {
      padding: 8px 12px;
    }
    .body {
      padding: 16px;
      gap: 12px;
    }
    .player {
      width: min(300px, 100%);
    }
  }
</style>
