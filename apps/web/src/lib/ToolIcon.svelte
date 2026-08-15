<script lang="ts">
  /**
   * Icon per nama tool, gaya two-tone: bentuk dasar diisi `currentColor` opacity
   * rendah (25%), aksen (stroke/detail utama) full opacity — jadi otomatis
   * ngikut warna teks di sekitarnya (lihat `.icon { color: ... }` di ToolCall).
   *
   * Pengelompokan nama tool sengaja disamakan dengan switch di tool-view.ts
   * supaya "tool apa dapat icon apa" cuma perlu diubah di satu tempat kalau
   * ada tool baru.
   */
  let { name }: { name: string } = $props()
</script>

{#if name === 'Bash' || name === 'BashOutput'}
  <svg class="ti" viewBox="0 0 20 20" fill="none">
    <rect x="2" y="3" width="16" height="14" rx="2" fill="currentColor" opacity="0.25" />
    <path d="M5.5 8L8.5 10.5L5.5 13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    <line x1="10.5" y1="13" x2="14.5" y2="13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  </svg>
{:else if name === 'Read'}
  <svg class="ti" viewBox="0 0 20 20" fill="none">
    <path d="M5 2.5h7l3 3v12H5z" fill="currentColor" opacity="0.25" />
    <path d="M12 2.5v3h3" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
    <line x1="7.5" y1="10" x2="13" y2="10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    <line x1="7.5" y1="13" x2="13" y2="13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
  </svg>
{:else if name === 'Write'}
  <svg class="ti" viewBox="0 0 20 20" fill="none">
    <path d="M5 2.5h7l3 3v12H5z" fill="currentColor" opacity="0.25" />
    <path d="M12 2.5v3h3" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
    <line x1="10" y1="9.5" x2="10" y2="14.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
    <line x1="7.5" y1="12" x2="12.5" y2="12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  </svg>
{:else if name === 'Edit' || name === 'NotebookEdit'}
  <svg class="ti" viewBox="0 0 20 20" fill="none">
    <path d="M5 2.5h7l3 3v12H5z" fill="currentColor" opacity="0.25" />
    <path d="M12 2.5v3h3" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
    <path
      d="M8 15l-1 2.2 2.2-1L15.5 9.9a1 1 0 0 0 0-1.4l-.5-.5a1 1 0 0 0-1.4 0z"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
  </svg>
{:else if name === 'Glob' || name === 'Grep'}
  <svg class="ti" viewBox="0 0 20 20" fill="none">
    <circle cx="8.5" cy="8.5" r="5" fill="currentColor" opacity="0.25" />
    <circle cx="8.5" cy="8.5" r="5" stroke="currentColor" stroke-width="1.5" />
    <line x1="12.3" y1="12.3" x2="17" y2="17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
  </svg>
{:else if name === 'WebFetch' || name === 'WebSearch'}
  <svg class="ti" viewBox="0 0 20 20" fill="none">
    <circle cx="10" cy="10" r="7" fill="currentColor" opacity="0.25" />
    <circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.3" />
    <ellipse cx="10" cy="10" rx="3" ry="7" stroke="currentColor" stroke-width="1.1" />
    <line x1="3" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="1.1" />
  </svg>
{:else if name === 'Task'}
  <svg class="ti" viewBox="0 0 20 20" fill="none">
    <rect x="4" y="5" width="12" height="10" rx="3" fill="currentColor" opacity="0.25" />
    <rect x="4" y="5" width="12" height="10" rx="3" stroke="currentColor" stroke-width="1.3" />
    <circle cx="8" cy="10" r="1.1" fill="currentColor" />
    <circle cx="12" cy="10" r="1.1" fill="currentColor" />
    <line x1="10" y1="5" x2="10" y2="2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    <circle cx="10" cy="2" r="1" fill="currentColor" />
  </svg>
{:else if name === 'TodoWrite'}
  <svg class="ti" viewBox="0 0 20 20" fill="none">
    <rect x="4" y="3" width="12" height="14" rx="2" fill="currentColor" opacity="0.25" />
    <rect x="4" y="3" width="12" height="14" rx="2" stroke="currentColor" stroke-width="1.3" />
    <path d="M7 8l1.5 1.5L11.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    <line x1="7" y1="13" x2="13" y2="13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
  </svg>
{:else}
  <svg class="ti" viewBox="0 0 20 20" fill="none">
    <rect x="3" y="3" width="14" height="14" rx="3" fill="currentColor" opacity="0.25" />
    <path d="M8 7L5 10L8 13M12 7L15 10L12 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
{/if}

<style>
  .ti {
    width: 14px;
    height: 14px;
    flex: none;
  }
</style>
