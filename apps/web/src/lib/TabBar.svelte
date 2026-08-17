<script lang="ts">
  import type { LaneMeta } from '@company/protocol'
  import { store } from './store.svelte.ts'

  const dot: Record<string, string> = {
    idle: '#5a6270',
    thinking: '#4a9eff',
    waiting: '#f5a623',
    ratelimited: '#f5a623',
    error: '#e5534b',
    offline: '#3a3f4a',
  }

  /** Status general = status lane paling menuntut perhatian (lihat Sidebar.svelte). */
  function generalStatus(lanes: LaneMeta[]): string {
    const s = lanes.map((l) => l.status)
    for (const want of ['waiting', 'error', 'thinking', 'ratelimited', 'idle']) {
      if (s.includes(want as (typeof s)[number])) return want
    }
    return 'offline'
  }

  function statusOf(id: string): string {
    if (store.isGeneral(id)) {
      const lanes = store.generalMeta(id)?.lanes ?? store.generalView(id)?.lanes ?? []
      return generalStatus(lanes)
    }
    return store.meta(id)?.status ?? 'offline'
  }

  function titleOf(id: string): string {
    if (store.isGeneral(id)) return store.generalMeta(id)?.title ?? store.generalView(id)?.title ?? 'General'
    return store.meta(id)?.title ?? '…'
  }
</script>

<div class="tabbar">
  {#each store.open as id (id)}
    <div class="tab" class:active={store.active === id}>
      <button class="tab-main" onclick={() => store.focus(id)} title={titleOf(id)}>
        <span class="dot" style:background={dot[statusOf(id)] ?? dot.offline}></span>
        {#if store.isGeneral(id)}
          <span class="sub general">general</span>
        {:else if store.hostNameOf(id)}
          <span class="sub">{store.hostNameOf(id)}</span>
        {/if}
        <span class="label">{titleOf(id)}</span>
      </button>
      <button class="tab-close" onclick={() => store.closePane(id)} title="Tutup tab">✕</button>
    </div>
  {/each}
</div>

<style>
  .tabbar {
    display: flex;
    align-items: stretch;
    flex: none;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    background: #14171c;
    border-bottom: 1px solid #23272f;
  }
  .tab {
    display: flex;
    align-items: stretch;
    /* Dinamis, bukan lebar tetap: tab tumbuh mengisi ruang kosong kalau cuma
       sedikit yang terbuka, menyusut sampai min-width kalau banyak — baru
       setelah itu overflow-x pada .tabbar yang ambil alih lewat scroll,
       persis tab browser. */
    flex: 1 1 160px;
    min-width: 120px;
    max-width: 260px;
    border-right: 1px solid #1b1f26;
  }
  .tab.active {
    background: #1a1d24;
  }
  .tab-main {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 9px 4px 9px 12px;
    background: none;
    border: none;
    color: #9aa3b2;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .tab.active .tab-main {
    color: #fff;
  }
  .tab-main .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
  }
  .tab-main .sub {
    color: #6b7280;
    flex: none;
  }
  .tab.active .tab-main .sub {
    color: #9aa3b2;
  }
  .tab-main .sub.general {
    color: #a78bfa;
  }
  .tab-main .sub::after {
    content: '·';
    margin-left: 6px;
    color: #3a3f4a;
  }
  .tab-main .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tab-close {
    background: none;
    border: none;
    color: #4b515c;
    font-size: 12px;
    line-height: 1;
    padding: 0 10px;
    cursor: pointer;
    flex: none;
  }
  .tab-close:hover {
    color: #e5534b;
  }

  @media (max-width: 768px) {
    .tab {
      flex-basis: 120px;
      min-width: 96px;
      max-width: 160px;
    }
  }
</style>
