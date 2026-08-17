<script lang="ts">
  import { dataUrlOf, type PendingAttachment } from './attachments.ts'

  let {
    attachments,
    onremove,
  }: {
    attachments: PendingAttachment[]
    onremove: (id: string) => void
  } = $props()
</script>

{#if attachments.length}
  <div class="chips">
    {#each attachments as a (a.id)}
      <div class="chip">
        {#if a.mime.startsWith('image/')}
          <img src={dataUrlOf(a)} alt={a.name} />
        {:else}
          <span class="doc">PDF</span>
        {/if}
        <span class="name" title={a.name}>{a.name}</span>
        <button type="button" class="rm" onclick={() => onremove(a.id)} title="Hapus lampiran">
          ✕
        </button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 16px 0;
  }
  .chip {
    display: flex;
    align-items: center;
    gap: 6px;
    background: #1f242c;
    border: 1px solid #2b303a;
    border-radius: 7px;
    padding: 4px 6px 4px 4px;
    max-width: 180px;
  }
  .chip img {
    width: 24px;
    height: 24px;
    object-fit: cover;
    border-radius: 4px;
    flex: none;
  }
  .chip .doc {
    width: 24px;
    height: 24px;
    flex: none;
    display: grid;
    place-items: center;
    background: #2b2f38;
    border-radius: 4px;
    font-size: 8px;
    font-weight: 700;
    color: #9aa3b2;
  }
  .name {
    font-size: 11px;
    color: #9aa3b2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .rm {
    background: none;
    border: none;
    color: #6b7280;
    cursor: pointer;
    font-size: 11px;
    padding: 0 2px;
    flex: none;
    line-height: 1;
  }
  .rm:hover {
    color: #e5534b;
  }

  @media (max-width: 768px) {
    .chip {
      max-width: 140px;
    }
  }
</style>
