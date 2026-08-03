import adapter from '@sveltejs/adapter-static'

export default {
  kit: {
    // SPA: seluruh UI digerakkan satu koneksi WS, tidak ada yang perlu SSR.
    adapter: adapter({ fallback: 'index.html' }),
    alias: { '@company/protocol': '../../packages/protocol/src/index.ts' },
  },
}
