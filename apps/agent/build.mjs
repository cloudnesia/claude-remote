#!/usr/bin/env node
/**
 * Bangun binary mandiri untuk platform yang SEDANG berjalan.
 *
 * Node SEA menyuntikkan blob ke dalam salinan binary `node` itu sendiri, jadi
 * cross-compile tidak mungkin — tiap target dibangun di runner-nya sendiri
 * (lihat .github/workflows/release.yml).
 *
 * Yang TIDAK ikut dipaket: Claude Code. Ukurannya 275MB, dan versinya harus
 * yang sudah login di mesin user. Agent mencarinya saat runtime lewat
 * apps/agent/src/claude.ts.
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync, chmodSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const out = join(here, 'dist')

const version = process.env.VERSION ?? 'dev'
const target = `${process.platform}-${process.arch}` // mis. linux-x64, darwin-arm64
const binName = `company-agent-${target}`

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// --- 1. bundle jadi satu file CJS (SEA butuh CJS) -------------------------

console.log(`[build] bundling (${target}, v${version})…`)
await build({
  entryPoints: [join(here, 'src', 'index.ts')],
  outfile: join(out, 'agent.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  // `ws` memuat dua modul opsional untuk optimasi; keduanya punya fallback JS
  // murni, jadi aman ditinggalkan dan ini menghindari kegagalan bundling.
  external: ['bufferutil', 'utf-8-validate'],
  define: {
    'process.env.AGENT_VERSION': JSON.stringify(version),
    'process.env.COMPANY_AGENT_PACKAGED': '"1"',
  },
  banner: {
    js: '// company-agent — dibangun dari sumber, lihat github repo\n',
  },
  logLevel: 'warning',
})

// --- 2. blob SEA ----------------------------------------------------------

const cfg = join(out, 'sea-config.json')
writeFileSync(
  cfg,
  JSON.stringify({
    main: join(out, 'agent.cjs'),
    output: join(out, 'sea.blob'),
    disableExperimentalSEAWarning: true,
    // Snapshot dimatikan: kode kita membaca env dan filesystem saat start,
    // yang tidak boleh dibekukan ke dalam snapshot build.
    useSnapshot: false,
    useCodeCache: true,
  }),
)

console.log('[build] membuat blob SEA…')
execFileSync(process.execPath, ['--experimental-sea-config', cfg], { stdio: 'inherit' })

// --- 3. suntik ke salinan binary node ------------------------------------

const binPath = join(out, binName)
copyFileSync(process.execPath, binPath)
chmodSync(binPath, 0o755)

// macOS menolak binary yang tanda tangannya tidak cocok setelah dimodifikasi.
if (process.platform === 'darwin') {
  try {
    execFileSync('codesign', ['--remove-signature', binPath], { stdio: 'inherit' })
  } catch {
    /* binary mungkin memang belum ditandatangani */
  }
}

console.log('[build] menyuntikkan blob…')
execFileSync(
  process.execPath,
  [
    join(root, 'node_modules', 'postject', 'dist', 'cli.js'),
    binPath,
    'NODE_SEA_BLOB',
    join(out, 'sea.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
  ],
  { stdio: 'inherit' },
)

if (process.platform === 'darwin') {
  // Ad-hoc signing sudah cukup untuk dijalankan lokal; tanpa ini macOS
  // membunuh prosesnya dengan SIGKILL tanpa pesan apa pun.
  execFileSync('codesign', ['--sign', '-', binPath], { stdio: 'inherit' })
}

const mb = (statSync(binPath).size / 1024 / 1024).toFixed(1)
console.log(`\n[build] selesai: apps/agent/dist/${binName} (${mb} MB)`)
