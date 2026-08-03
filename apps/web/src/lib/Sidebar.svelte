<script lang="ts">
  import { store, MAX_PANES } from './store.svelte.ts'
  import type { HostMeta } from '@company/protocol'

  let {
    onpair,
    onnew,
  }: { onpair: () => void; onnew: (host: HostMeta) => void } = $props()

  const dot: Record<string, string> = {
    idle: '#5a6270',
    thinking: '#4a9eff',
    waiting: '#f5a623',
    ratelimited: '#f5a623',
    error: '#e5534b',
    offline: '#3a3f4a',
  }

</script>

<aside>
  <header>
    <span class="dot" style:background={store.connected ? '#3fb950' : '#e5534b'}></span>
    <strong>Sessions</strong>
    <button class="pair" onclick={onpair} title="Hubungkan laptop">+ laptop</button>
  </header>

  {#each store.users as user (user.id)}
    <div class="user">
      <div class="user-name">
        {user.name}
        {#if user.id === store.me}<span class="you">kamu</span>{/if}
      </div>

      {#each user.hosts as host (host.id)}
        <div class="host">
          <span class="host-name" class:off={!host.online}>
            {host.online ? '●' : '○'}
            {host.name}
          </span>
          {#if host.online && user.id === store.me}
            <button class="add" onclick={() => onnew(host)} title="Session baru">+</button>
          {/if}
        </div>

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
      {:else}
        {#if user.id === store.me}
          <button class="link" onclick={onpair}>hubungkan laptop pertamamu</button>
        {/if}
      {/each}
    </div>
  {/each}
</aside>

<style>
  aside {
    width: 250px;
    flex: none;
    border-right: 1px solid #23272f;
    overflow-y: auto;
    background: #14171c;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 13px 12px 11px;
    border-bottom: 1px solid #23272f;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
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
  .user {
    padding: 10px 0 6px;
  }
  .user-name {
    padding: 4px 12px;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #6b7280;
  }
  .you {
    color: #4a9eff;
    text-transform: none;
    letter-spacing: 0;
  }
  .host {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 12px;
  }
  .host-name {
    font-size: 12px;
    color: #9aa3b2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .host-name.off {
    color: #4b515c;
  }
  .add {
    background: none;
    border: none;
    color: #6b7280;
    cursor: pointer;
    font-size: 15px;
    line-height: 1;
    padding: 0 4px;
    flex: none;
  }
  .add:hover {
    color: #e6e9ef;
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
    color: #4b515c;
    cursor: pointer;
    font-size: 12px;
    padding: 0 9px 0 3px;
    flex: none;
    opacity: 0;
  }
  .row:hover .pin {
    opacity: 1;
  }
  .pin:hover {
    color: #4a9eff;
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
</style>
