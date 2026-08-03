<script lang="ts">
  import { store, MAX_PANES } from './store.svelte.ts'
  import type { HostMeta } from '@company/protocol'

  let {
    onpair,
    onnew,
  }: { onpair: () => void; onnew: (host: HostMeta) => void } = $props()

  /** Host yang menunggu konfirmasi lepas. Dua langkah, bukan modal. */
  let confirming = $state<string | null>(null)
  let timer: ReturnType<typeof setTimeout> | null = null

  function askUnbind(hostId: string) {
    confirming = hostId
    if (timer) clearTimeout(timer)
    // Batalkan sendiri kalau ditinggal: tombol merah yang menetap gampang
    // tertekan tanpa sengaja belakangan.
    timer = setTimeout(() => (confirming = null), 5000)
  }

  function doUnbind(hostId: string) {
    if (timer) clearTimeout(timer)
    confirming = null
    store.unbindHost(hostId)
  }

  const dot: Record<string, string> = {
    idle: '#5a6270',
    thinking: '#4a9eff',
    waiting: '#f5a623',
    ratelimited: '#f5a623',
    error: '#e5534b',
    offline: '#3a3f4a',
  }

  // Deteksi duplikat nama dan buat display name yang unique
  function getDisplayName(host: any, allHosts: any[]): string {
    const sameName = allHosts.filter(h => h.name === host.name)
    if (sameName.length <= 1) return host.name

    // Ada duplikat - tambahkan suffix unik
    const index = sameName.indexOf(host)
    const suffix = host.online ? 'online' : 'offline'
    const shortId = host.id.substring(0, 6)
    return `${host.name} (${suffix} #${shortId})`
  }

  // Check apakah ada duplikat nama
  function hasDuplicateName(host: any, allHosts: any[]): boolean {
    return allHosts.filter(h => h.name === host.name).length > 1
  }

  // Sortir hosts: online dulu, kemudian by name
  function sortedHosts(hosts: any[]) {
    return [...hosts].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

</script>

<aside>
  <div class="branding">
    <div class="app-info">
      <div class="app-name">claude-remote</div>
      <div class="app-version">v0.1</div>
    </div>
    <a
      href="https://github.com/yourusername/claude-remote"
      target="_blank"
      rel="noopener noreferrer"
      class="github-link"
      title="View source on GitHub"
    >
      <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
      </svg>
    </a>
  </div>

  <header>
    <span class="dot" style:background={store.connected ? '#3fb950' : '#e5534b'}></span>
    <strong>Nodes</strong>
    <button class="pair" onclick={onpair} title="Hubungkan node baru">+ node</button>
  </header>

  {#each store.users as user (user.id)}
    {@const allHosts = store.users.flatMap(u => u.hosts)}
    {#each sortedHosts(user.hosts) as host (host.id)}
        <div
          class="host"
          class:duplicate={hasDuplicateName(host, allHosts)}
          title={hasDuplicateName(host, allHosts) ? 'Node dengan nama duplikat terdeteksi. Lepas node yang offline untuk menghindari konflik.' : ''}
        >
          <span class="host-name" class:off={!host.online} class:revoked={host.revoked}>
            {host.revoked ? '⊘' : host.online ? '●' : '○'}
            {getDisplayName(host, allHosts)}
            {#if host.revoked}<span class="tag">dilepas</span>{/if}
            {#if hasDuplicateName(host, allHosts) && !host.revoked}
              <span class="tag warn" title="Nama duplikat terdeteksi">⚠ duplikat</span>
            {/if}
          </span>
          {#if user.id === store.me && !host.revoked}
            <span class="hostacts">
              {#if confirming === host.id}
                <button class="unbind confirm" onclick={() => doUnbind(host.id)}>
                  yakin lepas?
                </button>
              {:else}
                <button
                  class="unbind"
                  onclick={() => askUnbind(host.id)}
                  title="Cabut pairing node ini"
                >
                  lepas
                </button>
              {/if}
            </span>
          {/if}
        </div>

        {#if user.id === store.me && !host.revoked && host.online}
          <button class="add-project" onclick={() => onnew(host)} title="Tambahkan session baru">
            <span class="plus-icon">+</span>
            Tambahkan project
          </button>
        {/if}

        {#each host.sessions as s (s.id)}
          {@const isOpen = store.open.includes(s.id)}
          <div class="row" class:active={isOpen}>
            <button class="session" onclick={() => store.focus(s.id)}>
              <span class="dot" style:background={dot[s.status]}></span>
              <span class="title">{s.title}</span>
              {#if s.status === 'waiting'}<span class="badge">izin</span>{/if}
            </button>
            {#if !isOpen && store.open.length < MAX_PANES && store.open.length > 0}
              <button
                class="pin"
                onclick={() => store.addPane(s.id)}
                title="Buka di pane sebelah"
              >
                ⊞
              </button>
            {/if}
          </div>
        {:else}
          <div class="empty">belum ada session</div>
        {/each}
    {/each}
  {/each}

  {#if store.users.every(u => u.hosts.length === 0)}
    <button class="link" onclick={onpair}>hubungkan node pertama</button>
  {/if}
</aside>

<style>
  aside {
    width: 250px;
    flex: none;
    border-right: 1px solid #23272f;
    overflow-y: auto;
    background: #14171c;
  }
  .branding {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 12px 10px;
    border-bottom: 1px solid #1a1d24;
    background: linear-gradient(135deg, #1a1d24 0%, #14171c 100%);
  }
  .app-info {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .app-name {
    font-size: 15px;
    font-weight: 700;
    color: #e6e9ef;
    letter-spacing: -0.02em;
  }
  .app-version {
    font-size: 10px;
    color: #6b7280;
    font-weight: 500;
    padding: 1px 5px;
    background: #1f242c;
    border-radius: 3px;
    border: 1px solid #2b303a;
  }
  .github-link {
    display: flex;
    align-items: center;
    justify-content: center;
    color: #6b7280;
    text-decoration: none;
    transition: all 0.2s ease;
    padding: 4px;
    border-radius: 4px;
  }
  .github-link:hover {
    color: #e6e9ef;
    background: rgba(255, 255, 255, 0.05);
  }
  .github-link svg {
    display: block;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 13px 12px 11px;
    border-bottom: 1px solid #23272f;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex: none;
    box-shadow: 0 0 4px currentColor;
  }
  .pair {
    margin-left: auto;
    background: #1f242c;
    border: 1px solid #2b303a;
    color: #9aa3b2;
    border-radius: 5px;
    font: inherit;
    font-size: 11px;
    padding: 3px 8px;
    cursor: pointer;
  }
  .pair:hover {
    color: #e6e9ef;
    border-color: #3a4759;
  }
  .host {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px 6px;
    margin-top: 8px;
    border-left: 2px solid transparent;
    transition: border-color 0.2s ease;
  }
  .host:first-of-type {
    margin-top: 4px;
  }
  .host.duplicate {
    border-left-color: #f5a623;
    background: rgba(245, 166, 35, 0.05);
  }
  .host-name {
    font-size: 13px;
    color: #9aa3b2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .host-name.off {
    color: #4b515c;
  }
  .hostacts {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }
  .host-name.revoked {
    color: #4b515c;
    text-decoration: line-through;
  }
  .tag {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
    text-decoration: none;
    margin-left: 3px;
  }
  .tag.warn {
    color: #f5a623;
    background: rgba(245, 166, 35, 0.15);
    padding: 1px 4px;
    border-radius: 2px;
  }
  .unbind {
    background: none;
    border: none;
    color: #4b515c;
    font: inherit;
    font-size: 10px;
    padding: 0 3px;
    cursor: pointer;
    opacity: 0;
  }
  .host:hover .unbind {
    opacity: 1;
  }
  .unbind:hover {
    color: #e5534b;
  }
  .unbind.confirm {
    opacity: 1;
    color: #e5534b;
    font-weight: 600;
  }
  .add-project {
    display: flex;
    align-items: center;
    gap: 6px;
    width: calc(100% - 24px);
    margin: 4px 12px 6px;
    padding: 6px 10px;
    background: none;
    border: 1.5px dashed #3a3f4a;
    border-radius: 6px;
    color: #9aa3b2;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.2s ease;
  }
  .add-project:hover {
    border-color: #4a9eff;
    color: #4a9eff;
    background: rgba(74, 158, 255, 0.05);
  }
  .plus-icon {
    font-size: 16px;
    font-weight: bold;
    line-height: 1;
  }
  .row {
    display: flex;
    align-items: center;
  }
  .row:hover {
    background: #1b1f26;
  }
  .row.active {
    background: #1f2937;
  }
  .session {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    padding: 5px 6px 5px 24px;
    background: none;
    border: none;
    color: #c9d1d9;
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .row.active .session {
    color: #fff;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    margin-left: auto;
    font-size: 10px;
    background: #f5a623;
    color: #1a1d23;
    border-radius: 3px;
    padding: 1px 5px;
    flex: none;
  }
  .pin {
    background: none;
    border: none;
    color: #6b7280;
    cursor: pointer;
    font-size: 16px;
    padding: 0 9px 0 3px;
    flex: none;
    opacity: 0;
  }
  .row:hover .pin {
    opacity: 1;
  }
  .pin:hover {
    color: #4a9eff;
    transform: scale(1.15);
  }
  .empty {
    padding: 3px 24px;
    font-size: 12px;
    color: #4b515c;
  }
  .link {
    display: block;
    background: none;
    border: none;
    color: #4a9eff;
    font: inherit;
    font-size: 12px;
    padding: 3px 12px;
    cursor: pointer;
    text-align: left;
  }

  /* Mobile responsive */
  @media (max-width: 768px) {
    aside {
      width: 100%;
      max-height: 200px;
      border-right: none;
      border-bottom: 1px solid #23272f;
      flex-shrink: 0;
    }
    .branding {
      padding: 10px 12px 8px;
    }
    .app-name {
      font-size: 14px;
    }
    .app-version {
      font-size: 9px;
      padding: 1px 4px;
    }
    .github-link {
      padding: 6px;
    }
    .github-link svg {
      width: 20px;
      height: 20px;
    }
    .session {
      padding: 8px 6px 8px 24px;
      font-size: 14px;
    }
    .pin {
      font-size: 18px;
      padding: 0 12px 0 6px;
    }
    .host-name {
      font-size: 14px;
    }
    .add-project {
      padding: 8px 12px;
      font-size: 13px;
      margin: 6px 12px 8px;
    }
    .plus-icon {
      font-size: 18px;
    }
  }

  /* Landscape mobile or tablets */
  @media (min-width: 769px) and (max-width: 1024px) {
    aside {
      width: 220px;
    }
  }
</style>
