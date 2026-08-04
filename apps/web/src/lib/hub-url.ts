/**
 * Alamat hub, ditentukan saat **runtime**.
 *
 * Sebelumnya nilai ini datang dari `import.meta.env.VITE_HUB_URL`. Vite
 * mengganti ekspresi itu dengan literal saat build, jadi satu build statis
 * terikat mati ke satu domain: ganti domain, atau sekadar salah mengisi
 * HUB_URL saat install, berarti harus build ulang seluruh UI. Itu jebakan
 * yang mahal untuk sesuatu yang sebenarnya cuma satu string.
 *
 * Urutan yang dipakai, dari yang paling spesifik:
 *
 *   1. `window.__HUB_URL__` — disuntikkan ke index.html oleh `serve.mjs` dari
 *      env `HUB_URL`. Ini yang membuat "ubah env, restart web" cukup, tanpa
 *      build ulang. Wajib untuk pemasangan tanpa reverse proxy, di mana UI
 *      (:8080) dan hub (:8787) beda origin.
 *   2. `VITE_HUB_URL` — hanya untuk `npm run web` saat dev (web di :5173,
 *      hub di :8787). Di dev tidak ada "sesudah build", jadi build-time wajar.
 *   3. Diturunkan dari `location` — deployment di belakang nginx selalu
 *      same-origin, jadi origin halaman ini memang alamat hub-nya. Satu build
 *      jalan di domain mana pun tanpa dikonfigurasi sama sekali.
 */

/** Sub-path tempat nginx melayani hub; sisi hub menyebutnya `BASE_PATH`. */
const DEFAULT_BASE_PATH = '/socket'

declare global {
  interface Window {
    __HUB_URL__?: string
  }
}

function fromLocation(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${DEFAULT_BASE_PATH}`
}

function resolve(): string {
  // `window` tidak ada saat prerender/SSR. Nilai apa pun di sini tidak akan
  // terpakai — modul dievaluasi ulang di browser — tapi harus tidak melempar.
  if (typeof window === 'undefined') return import.meta.env.VITE_HUB_URL ?? ''

  const injected = window.__HUB_URL__
  if (injected) return injected.replace(/\/+$/, '')

  const built = import.meta.env.VITE_HUB_URL
  if (built) return built.replace(/\/+$/, '')

  return fromLocation()
}

export const HUB = resolve()

/** Endpoint pairing dan `/me` memakai HTTP di origin yang sama persis. */
export const HUB_HTTP = HUB.replace(/^ws/, 'http')
