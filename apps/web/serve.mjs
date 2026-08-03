#!/usr/bin/env node
/**
 * Penyaji file statis untuk hasil `vite build`.
 *
 * Sengaja tanpa dependensi: satu-satunya alasan service ini ada adalah supaya
 * web dan hub bisa dijalankan sebagai dua unit systemd terpisah. Untuk
 * produksi sungguhan, taruh nginx di depan (lihat README) — ini cukup untuk
 * VPS sederhana tanpa reverse proxy.
 */
import { createServer } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'

const ROOT = resolve(process.env.WEB_ROOT ?? join(import.meta.dirname, 'build'))
const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '0.0.0.0'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function resolveFile(urlPath) {
  // normalize() melipat '..' sebelum join, jadi path di luar ROOT tidak bisa
  // dibentuk. Tanpa ini `GET /../../etc/passwd` bisa lolos.
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '')
  const candidate = join(ROOT, clean)
  if (!candidate.startsWith(ROOT)) return null

  try {
    const st = statSync(candidate)
    if (st.isFile()) return candidate
    if (st.isDirectory()) {
      const idx = join(candidate, 'index.html')
      if (statSync(idx).isFile()) return idx
    }
  } catch {
    /* jatuh ke SPA fallback */
  }
  return null
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }

  // SPA: rute apa pun yang bukan file nyata dilayani index.html, supaya
  // reload di URL dalam aplikasi tidak menghasilkan 404.
  const file = resolveFile(req.url ?? '/') ?? join(ROOT, 'index.html')
  const ext = extname(file)

  let size
  try {
    size = statSync(file).size
  } catch {
    res.writeHead(404).end('not found')
    return
  }

  res.writeHead(200, {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'content-length': size,
    // Aset ber-hash dari Vite aman di-cache selamanya; sisanya tidak boleh,
    // kalau tidak deploy baru tidak akan pernah terlihat oleh pengunjung lama.
    'cache-control': req.url?.startsWith('/_app/immutable/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
    'x-content-type-options': 'nosniff',
  })

  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
})

server.listen(PORT, HOST, () => {
  console.log(`[web] menyajikan ${ROOT} di http://${HOST}:${PORT}`)
})
