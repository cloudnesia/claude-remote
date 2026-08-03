# Multi-session Claude Code over the web

Banyak session Claude Code berjalan bersamaan, masing-masing di **laptop
pemiliknya sendiri** dengan subscription-nya sendiri. Web hanya antarmuka.

```
Laptop A ──┐
Laptop B ──┼──► Hub (WS relay + SQLite)  ◄──► Browser (SvelteKit)
Laptop C ──┘     tidak pernah melihat kredensial Claude,
                 tidak pernah memanggil API Anthropic
```

Agent selalu **dial keluar** ke hub, jadi host tidak perlu membuka port dan
tetap jalan dari balik NAT / wifi kafe.

## Jalankan

Butuh Node ≥ 24 (dipakai untuk menjalankan `.ts` langsung dan `node:sqlite`)
dan Claude Code yang sudah login di mesin agent.

```bash
npm install
npm run seed          # cetak token dev untuk user

npm run hub           # terminal 1
npm run web           # terminal 2
# buka http://localhost:5173/?token=usr_…
```

Lalu hubungkan laptop lewat **device-code pairing**, seperti `gh auth login`:

```bash
npm run agent -- login    # di laptop yang mau dihubungkan (dari source)
#   Buka  http://localhost:5173  lalu masukkan kode ini:
#       F98M-VUU2
```

Ketik kode itu di web (tombol **+ laptop**). Agent menerima host token-nya
sendiri, menyimpannya di `~/.company-agent/config.json` dengan mode `0600`,
lalu:

```bash
npm run agent             # = company-agent start
```

Kredensial Claude user tidak pernah lewat hub — agent memakai `~/.claude`
di laptopnya sebagai proses lokal biasa.

`npm run seed` membuat dua user (Savana, Rekan) supaya visibility antar-user
bisa langsung dicoba. Login user sungguhan belum ada; token seeder masih jadi
satu-satunya cara masuk ke web.

## Memasang agent di laptop lain

Pengguna lain tidak perlu clone repo ini:

```sh
curl -fsSL https://github.com/cloudnesia/claude-remote/releases/latest/download/install.sh | sh
company-agent login
company-agent start
```

Binary-nya mandiri (Node ter-embed, ~118 MB) untuk `linux-x64`, `linux-arm64`,
`darwin-x64`, `darwin-arm64`. Installer memverifikasi checksum SHA-256 dan
tidak memasang apa pun kalau tidak cocok.

Yang **tidak** ikut dipaket: Claude Code itu sendiri. Ukurannya 275 MB, dan
yang dibutuhkan justru instalasi yang sudah login di mesin itu. Agent
mencarinya saat runtime di `PATH`, `~/.local/bin`, `~/.claude/local`,
`/usr/local/bin`, dan `/opt/homebrew/bin` — atau tunjuk manual dengan
`CLAUDE_BIN=/path/ke/claude`.

Efek sampingnya menguntungkan: karena memakai Claude Code milik user, daftar
model ikut versinya. Di mesin dengan CLI terbaru muncul Sonnet 5 / Opus 5 /
Fable 5 / Haiku, sedangkan cli.js bawaan SDK hanya menawarkan tiga.

Rilis dipicu dengan tag:

```sh
git tag v0.1.0 && git push --tags
```

`.github/workflows/release.yml` membangun keempat target di runner-nya
masing-masing — Node SEA menyuntik blob ke binary `node` milik runner, jadi
cross-compile mustahil. Build lokal untuk platform sendiri: `npm run build:agent`.

### Bikin session & pilih project directory

Klik **+** di sebelah nama host yang online di sidebar. Dialognya menjelajahi
filesystem laptop itu — mulai dari home host, klik folder untuk masuk, `..`
untuk naik, lalu **Buat di sini**. Judul otomatis mengikuti nama folder.

Daftar direktori dibaca dari host lewat agent, bukan ditebak browser: browser
tidak tahu apa-apa soal filesystem laptop itu. Hanya owner host yang boleh
menjelajah, dan hanya direktori yang ditampilkan (dotdir dan `node_modules`
disembunyikan).

### Ganti model

Dropdown di header pane, per session, owner saja. Isinya dienumerasi dari
Claude Code di laptop itu — bukan daftar hardcode — jadi selalu cocok dengan
akun dan versi CLI di sana.

Kalau session sedang berjalan, model berpindah saat itu juga tanpa restart.
Kalau sedang cold, dipakai saat proses berikutnya dinyalakan.

### Auto mode

Toggle `auto off` / `auto on` di header pane, per session, owner saja.
Saat aktif, setiap tool langsung dijalankan tanpa menunggu izin.

Tool call tetap tercatat penuh di transcript — auto mode menghapus kesempatan
menolak, bukan jejaknya. Statusnya juga terlihat oleh viewer lain, jadi tidak
ada session yang diam-diam berjalan tanpa pengawasan. Ingat konsekuensinya:
apa pun yang Claude putuskan akan langsung berjalan di laptop itu.

### "token user tidak valid"

Token user hidup di `./data/hub.db`. Menghapus folder `data/` mematikan semua
token lama — jalankan `npm run seed` lagi dan pakai yang baru. Web akan
mengatakannya langsung di layar masuk, bukan diam dengan sidebar kosong:
sebelum membuka WebSocket ia memeriksa `GET /me` dulu, karena browser tidak
bisa melihat status HTTP dari handshake WS yang ditolak (`onerror` kosong,
`onclose` selalu 1006) sehingga token mati dan hub mati tampak identik.

## Isi repo

| path | isi |
|------|-----|
| `docs/PROTOCOL.md` | **kontrak wire.** Ubah ini dulu sebelum ubah kode. |
| `packages/protocol` | tipe TS bersama + `applyEv` (perakit delta) |
| `apps/hub` | relay WS, SQLite, live buffer, coalescing, otorisasi, pairing |
| `apps/agent` | pembungkus Claude Agent SDK, outbox, registry session lokal, CLI |
| `apps/web` | SvelteKit SPA, multi-pane |

## Empat keputusan yang menentukan bentuk kode ini

1. **`seq` di-assign agent, bukan hub.** Satu-satunya cara agent tahu apa yang
   harus dikirim ulang setelah laptop sleep atau ganti wifi.
2. **Link agent→hub lossless, link hub→browser boleh lossy.** Hub menggabungkan
   delta teks per 60ms sebelum fan-out; tanpa itu satu session dengan 10 viewer
   berarti ribuan WS frame per detik.
3. **Yang di-persist ≠ yang di-broadcast.** DB menyimpan satu row per giliran.
   Delta hidup di memori hub saja.
4. **Otorisasi ditegakkan di hub.** Tombol yang di-disable bukan kontrol akses.
   Baca mengikuti `visibility`; prompt/interrupt/approve hanya owner.

Poin 4 bukan sekadar soal keamanan: tiap agent memakai subscription Claude milik
pemilik laptop, jadi membiarkan user lain mem-*prompt* session orang berarti
mengeksekusi shell di mesin orang lain sekaligus membakar kuota subscription-nya.
Rinciannya di `docs/PROTOCOL.md` §5.

## Yang sudah diverifikasi end-to-end

- Prompt dari browser → Claude Code di host → teks streaming balik
- Tool call: input JSON parsial saat streaming, hasil menempel ke blok yang benar
- Approval round-trip; session membeku sampai owner memutuskan
- Late joiner menerima transcript + giliran yang sedang berjalan + approval tertunda
- Restart agent penuh: konteks percakapan pulih via `resume`, `seq` lanjut tanpa tabrakan
- Restart hub + agent bersamaan: transcript utuh dari DB, seq lanjut benar
- User lain bisa baca, tapi hub menolak prompt-nya
- Pairing: kode kedaluwarsa 5 menit, sekali pakai, rate limit 10 percobaan/user
- Dua host milik satu user, dua pane berdampingan, streaming bersamaan
- Penjelajahan direktori host, dan session dibuat dari path hasil penjelajahan
- Auto mode: tool jalan tanpa `approval_req`; dimatikan lagi → minta izin lagi
- cwd salah → error jelas di transcript, agent tetap hidup
- Ganti model: enumerasi dari host, berpindah saat proses hidup, dan
  diverifikasi lewat session bersih di kedua arah (haiku ↔ opus)

## Belum ada

- **Login user** — token seeder masih satu-satunya cara masuk ke web. Ini
  lubang auth terakhir yang tersisa; pairing host sudah tidak pakai token manual.
- **Eviction idle** sudah ditulis (`IDLE_MS`, default 10 menit) tapi belum
  diuji di bawah kondisi idle sungguhan.
- **Hapus session** — `close_session` ada di protokol tapi belum ada tombolnya.
- **Virtualisasi transcript** — akan terasa berat di atas beberapa ribu blok.
- **Visibility belum bisa diubah dari UI** (default `team`, kolomnya sudah ada).
- **Revoke host** — bisa `company-agent logout` di laptopnya, tapi belum ada
  cara mencabut token dari sisi web kalau laptopnya hilang.
