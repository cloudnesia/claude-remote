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
# HUB_URL/WEB_URL wajib saat dev: default agent menunjuk ke hub publik
HUB_URL=ws://localhost:8787 WEB_URL=http://localhost:5173 \
  npm run agent -- login    # di laptop yang mau dihubungkan (dari source)
#   Buka  http://localhost:5173  lalu masukkan kode ini:
#       F98M-VUU2
```

Lebih enak taruh keduanya di `.env` — `npm run hub|agent` sudah membacanya.

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

Tanpa konfigurasi apa pun, agent memakai hub publik
**`claude.pinuspintar.com`** (`wss://claude.pinuspintar.com/socket`, web-nya
`https://claude.pinuspintar.com`) — jadi `company-agent login` langsung
mencetak kode yang bisa dipakai. Untuk hub sendiri, timpa saat login;
alamatnya ikut tersimpan di config:

```sh
HUB_URL=wss://hub.contoh.com WEB_URL=https://hub.contoh.com company-agent login
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

## Pasang server (hub + web) sekali jalan

```sh
curl -fsSL https://raw.githubusercontent.com/cloudnesia/claude-remote/main/install-server.sh | sudo sh
```

Atau dari dalam checkout: `sudo sh install-server.sh`.

Satu panggilan menyiapkan **dua service systemd terpisah**:

| service | isi |
|---------|-----|
| `claude-hub.service` | relay WebSocket + SQLite, port 8787 |
| `claude-web.service` | UI statis lewat `apps/web/serve.mjs`, port 8080 |

Dipisah karena keduanya punya siklus hidup berbeda: hub memegang koneksi
panjang dan state, web hanya menyajikan file. Restart UI tidak boleh memutus
session siapa pun.

Yang dilakukan script:

- Memakai Node sistem kalau ≥24, kalau tidak mengunduh Node resmi ke
  `/opt/claude-remote/node` — tidak mengotori paket sistem.
- Mengambil sumber dari checkout (isi direktori kerja, minus yang di-gitignore)
  atau `git clone` kalau dijalankan lewat curl.
- `npm ci`, lalu build UI dengan `VITE_HUB_URL` yang ditanam.
- Membuat user sistem `claude-remote`, DB di `/var/lib/claude-remote`.
- Menulis unit dengan pengetatan (`ProtectSystem=strict`, `NoNewPrivileges`,
  `ProtectHome`) — service hanya bisa menulis ke direktori state-nya.
- Seed user awal **hanya kalau DB belum ada**, lalu mencetak tokennya.

Variabel yang sering dipakai:

```sh
HUB_URL=wss://hub.contoh.com/socket BIND=127.0.0.1 sudo -E sh install-server.sh
```

`HUB_URL` **ditanam saat build**, jadi ganti domain berarti jalankan ulang
script-nya. Sub-path di dalamnya (`/socket`) otomatis menjadi `BASE_PATH` hub.
`BIND=127.0.0.1` untuk pemasangan di belakang nginx; default `0.0.0.0` supaya
VPS tanpa proxy langsung bisa dipakai.

Kelola seperti service biasa:

```sh
systemctl status claude-hub claude-web
journalctl -u claude-hub -f
```

## Deploy hub di belakang nginx

Hub bisa ditaruh di belakang nginx seperti aplikasi WebSocket lain. Satu server
block menyajikan UI sekaligus mem-proxy hub, jadi UI dan API berada di origin
yang sama dan CORS tidak lagi relevan.

Hub melayani lima path: `/ws` (browser), `/agent` (agent), lalu `/me`,
`/pair/*`, `/health`. Semuanya diturunkan dari **satu** base URL di sisi klien,
jadi cukup satu `location` kalau base URL-nya diberi sub-path.

### Konfigurasi default: hub di sub-path `/socket`

Ini yang dipakai deployment `claude.pinuspintar.com` dan yang menjadi default
`DEFAULT_HUB_URL`. `location /socket` sudah cukup untuk semua endpoint hub —
nginx meneruskan URI apa adanya, dan hub mengupas prefiksnya lewat `BASE_PATH`.

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

upstream claude_backend { server localhost:8080; }   # claude-web.service
upstream claude_socket  { server localhost:8787; }   # claude-hub.service

server {
  listen 443 ssl;
  server_name claude.pinuspintar.com;

  ssl_certificate     /etc/nginx/ssl/claude.pinuspintar.com/cert.pem;
  ssl_certificate_key /etc/nginx/ssl/claude.pinuspintar.com/key.pem;
  ssl_protocols       TLSv1.2 TLSv1.3;
  ssl_ciphers         HIGH:!aNULL:!MD5;

  # Hub: /socket/ws, /socket/agent, /socket/me, /socket/pair/*, /socket/health
  location /socket {
    proxy_pass         http://claude_socket;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Connection        $connection_upgrade;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;

    proxy_read_timeout 3600s;   # WAJIB — lihat catatan di bawah
    proxy_send_timeout 3600s;
    proxy_buffering    off;
  }

  # UI statis. Blok ini TIDAK boleh mengirim header Upgrade — serve.mjs
  # penyaji file biasa, dan `Connection: upgrade` yang dipaksakan ke sana
  # cuma bikin keep-alive kacau tanpa manfaat apa pun.
  location / {
    proxy_pass         http://claude_backend;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
  }
}
```

Pasang dengan sub-path ikut di `HUB_URL` — installer menurunkan `BASE_PATH`
dari situ dan menulisnya ke `/etc/claude-remote/hub.env`:

```sh
HUB_URL=wss://claude.pinuspintar.com/socket BIND=127.0.0.1 sudo -E sh install-server.sh
```

Agent memakai base URL yang sama (sudah jadi default, jadi boleh dikosongkan):

```sh
HUB_URL=wss://claude.pinuspintar.com/socket company-agent login
```

Konversi ke HTTP untuk endpoint pairing terjadi otomatis dan benar —
`wss://` menjadi `https://`, sub-path ikut terbawa.

### Alternatif: hub di root, UI disajikan nginx langsung

Kalau lebih suka tanpa sub-path, `claude-web.service` bisa dimatikan dan nginx
menyajikan hasil build sendiri. `BASE_PATH` dikosongkan, `HUB_URL` tanpa path.

```nginx
server {
  listen 443 ssl;
  server_name hub.perusahaan.com;

  root /opt/claude-remote/app/apps/web/build;
  location / { try_files $uri $uri/ /index.html; }   # SPA fallback

  location ~ ^/(ws|agent)$ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;

    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
  }

  location ~ ^/(me|health|pair/.+)$ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### Kenapa `proxy_read_timeout` wajib dinaikkan

Ini menutupi kekurangan di sisi hub, bukan sekadar tuning. Heartbeat hub hanya
mem-ping koneksi **agent**; koneksi **browser** tidak pernah di-ping. Saat
seseorang hanya menonton session yang sedang diam, tidak ada trafik sama sekali
di koneksi itu, dan nginx dengan default 60 detik akan memutusnya tiap menit.

Klien memang auto-reconnect, jadi tidak ada yang rusak — tapi setiap reconnect
menarik ulang snapshot transcript penuh. Pada transcript panjang itu pemborosan
berulang, dan indikator koneksi berkedip terus.

Menaikkan timeout memperbaikinya di nginx yang kamu kendalikan. Yang tidak
tertolong: Cloudflare, load balancer cloud, atau proxy korporat di jalur, yang
punya batas idle sendiri. Perbaikan sebenarnya adalah mem-ping browser juga —
belum dikerjakan, tercatat di bagian "Belum ada".

### Alamat hub masih ditanam saat build

```js
const HUB = import.meta.env.VITE_HUB_URL ?? 'ws://localhost:8787'
```

Untuk deployment di atas, build UI-nya dengan:

```sh
VITE_HUB_URL=wss://claude.pinuspintar.com/socket npm run build --workspace=web
```

Artinya satu build terikat ke satu domain. Karena setup nginx ini selalu
same-origin, sebenarnya alamat itu bisa diturunkan dari `location` saat runtime
sehingga satu build statis jalan di domain mana pun — juga belum dikerjakan.

## Pemakaian

### Bikin session & pilih project directory

Klik **+** di sebelah nama host yang online di sidebar. Dialognya menjelajahi
filesystem laptop itu — mulai dari home host, klik folder untuk masuk, `..`
untuk naik, lalu **Buat di sini**. Judul otomatis mengikuti nama folder.

Daftar direktori dibaca dari host lewat agent, bukan ditebak browser: browser
tidak tahu apa-apa soal filesystem laptop itu. Hanya owner host yang boleh
menjelajah, dan hanya direktori yang ditampilkan (dotdir dan `node_modules`
disembunyikan).

### Melepas laptop

Arahkan kursor ke nama host di sidebar, klik **lepas**, lalu klik sekali lagi
untuk konfirmasi (tombolnya batal sendiri setelah 5 detik). Owner host saja.

Yang terjadi:

- Token host dicabut **dan dirotasi**, bukan sekadar ditandai — kalau nilai
  lamanya sempat bocor, menandai saja menyisakan rahasia yang masih hidup.
- Agent yang sedang tersambung diberi tahu, membuang `config.json`-nya, lalu
  berhenti. Ini kebersihan untuk kasus normal, **bukan** kontrol keamanan:
  laptop yang hilang bisa saja mengabaikannya. Yang menentukan adalah token
  yang sudah mati di hub.
- Host tanpa session dihapus dari daftar. Host yang punya session
  **dipertahankan** sebagai arsip, ditandai `dilepas`, transcript tetap bisa
  dibaca — mencabut kredensial bukan alasan menghancurkan riwayat.

Tidak bisa dibatalkan; laptop itu harus `company-agent login` lagi.

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
| `apps/web` | SvelteKit SPA, multi-pane, + `serve.mjs` statis tanpa dependensi |
| `install-server.sh` | pasang hub + web sebagai dua service systemd |
| `install.sh` | pasang binary agent di laptop |

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
- Installer server: export direktori kerja, `npm ci`, build dengan `VITE_HUB_URL`
  tertanam, hub dan web jalan berdampingan, unit systemd lolos
  `systemd-analyze verify`, dan `BIND` benar-benar membatasi alamat listen
- Lepas laptop: token mati (401 saat coba sambung lagi), agent membuang config
  dan berhenti, host tanpa session terhapus, host bertranscript jadi arsip,
  dan user lain ditolak hub saat mencoba mencabut host orang
- Ganti model: enumerasi dari host, berpindah saat proses hidup, dan
  diverifikasi lewat session bersih di kedua arah (haiku ↔ opus)

## Belum ada

- **Login user** — token seeder masih satu-satunya cara masuk ke web. Ini
  lubang auth terakhir yang tersisa; pairing host sudah tidak pakai token manual.
- **Eviction idle** sudah ditulis (`IDLE_MS`, default 10 menit) tapi belum
  diuji di bawah kondisi idle sungguhan.
- **Hapus session** — `close_session` ada di protokol tapi belum ada tombolnya.
- **Heartbeat ke browser** — hub hanya mem-ping agent, sehingga koneksi browser
  yang idle diputus oleh proxy dengan batas idle pendek. Detail dan dampaknya
  di bagian nginx di atas.
- **Alamat hub same-origin** — masih ditanam saat build lewat `VITE_HUB_URL`,
  jadi satu build terikat ke satu domain.
- **Agent belum bisa diberi alamat hub lewat argumen** — hanya `HUB_URL`.
  Tidak lagi fatal sejak default-nya `wss://claude.pinuspintar.com/socket` (bukan
  `localhost`), tapi yang memasang hub sendiri masih harus tahu env var itu.
- **Virtualisasi transcript** — akan terasa berat di atas beberapa ribu blok.
- **Visibility belum bisa diubah dari UI** (default `team`, kolomnya sudah ada).
