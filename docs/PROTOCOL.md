# Wire protocol v1

Kontrak antara tiga komponen. Ubah ini dulu sebelum ubah kode.

```
Agent (laptop user)  ──WS /agent──►  Hub  ──WS /ws──►  Browser
   Claude Agent SDK                relay + DB           SvelteKit
```

Semua pesan adalah JSON teks satu baris. Field `v` wajib ada di frame handshake;
versi mismatch = tutup koneksi dengan close code 4426.

---

## 1. Prinsip yang menentukan bentuk protokol ini

Tiga hal ini yang bikin desainnya seperti di bawah. Kalau salah satu dilanggar,
protokolnya rusak diam-diam:

1. **`seq` di-assign AGENT, bukan hub.** Per-session, monotonic, mulai dari 1.
   Ini satu-satunya cara agent bisa tahu apa yang harus dikirim ulang setelah
   laptop reconnect.
2. **Link agent→hub lossless; link hub→browser boleh lossy.** Agent menyimpan
   frame sampai di-ack hub. Hub bebas menggabungkan delta sebelum fan-out ke
   browser — viewer tidak peduli menerima 40 delta atau 1 delta gabungan.
3. **Yang di-persist ≠ yang di-broadcast.** DB hanya menyimpan pesan final
   (satu row per giliran). Delta bersifat sementara dan hidup di memori hub.

---

## 2. Event stream (`Frame.ev`)

Ini payload yang mengalir dari agent, lewat hub, ke browser. Agent
**menormalisasi** output Claude Agent SDK ke bentuk ini — browser tidak pernah
melihat struktur SDK, supaya update SDK tidak merusak frontend.

```ts
type Frame = {
  sessionId: string
  seq: number          // per-session, monotonic, di-assign agent
  ts: number           // epoch ms di agent
  ev: Ev
}
```

| `ev.t`            | field                              | arti |
|-------------------|------------------------------------|------|
| `user_msg`        | `text`                             | prompt user, di-echo balik oleh agent |
| `turn_start`      | —                                  | giliran assistant dimulai |
| `text_delta`      | `blk`, `text`                      | potongan teks jawaban |
| `thinking_delta`  | `blk`, `text`                      | potongan extended thinking |
| `tool_start`      | `blk`, `id`, `name`                | assistant mulai menyusun tool call |
| `tool_input`      | `blk`, `partial`                   | JSON **parsial** — jangan `JSON.parse` |
| `tool_done`       | `blk`, `input`                     | input tool utuh & tervalidasi |
| `tool_result`     | `id`, `ok`, `content`              | hasil eksekusi tool |
| `turn_end`        | `stopReason`                       | giliran selesai; buffer live di-flush ke DB |
| `approval_req`    | `reqId`, `name`, `input`           | agent menunggu izin; session freeze |
| `approval_done`   | `reqId`, `decision`                | izin sudah diputuskan (juga untuk viewer) |
| `result`          | `usage`, `costUsd`, `durationMs`   | ringkasan akhir dari SDK |
| `status`          | `status`, `detail?`                | `idle`/`thinking`/`waiting`/`ratelimited`/`error` |
| `error`           | `message`, `fatal`                 | error dari SDK atau agent |

### Catatan implementasi

- `blk` adalah index content block dari API, dipakai browser untuk merakit
  ulang blok tanpa perlu urutan yang sempurna.
- `tool_input` datang sebagai JSON parsial yang **belum valid** (`{"file_pa`).
  Tampilkan mentah sebagai indikator progres; parse hanya saat `tool_done`.
- `approval_req` membekukan session sampai ada `approval_resp`. UI wajib
  menonjolkannya — kalau tidak, session menggantung tanpa penjelasan.

### `AskUserQuestion`: approval yang butuh isi, bukan cuma izin

Claude Code bertanya balik lewat tool bawaan `AskUserQuestion`, dan tool itu
lewat jalur `approval_req` yang sama seperti tool lain. Bedanya: mengizinkan
saja tidak cukup. Jawaban user masuk ke percakapan **hanya** lewat field
`answers` di dalam input tool — `Record<pertanyaan, jawaban>`, multi-select
digabung koma. Approve tanpa `answers` membuat Claude menerima "your questions
have been answered" yang kosong, lalu menebak sendiri.

Karena itu:

- `approve` / `approval_resp` membawa `answers?` opsional; agent menempelkannya
  ke `updatedInput` sebelum meneruskan izin ke SDK.
- Tool ini **selalu** ditanyakan ke owner, bahkan saat `auto` menyala. Auto mode
  artinya "tidak usah minta izin", bukan "jawab sendiri" — tidak ada jawaban
  yang bisa ditebak agent.
- Menolaknya sah: Claude menerima "user tidak menjawab" dan lanjut sendiri.

---

## 3. Agent ↔ Hub (`WS /agent?token=<hostToken>`)

Agent selalu yang **dial keluar**. Host tidak pernah membuka port. Ini yang
bikin sistem jalan dari wifi kafe / di belakang NAT.

### Hub → Agent

| `t`              | field                                   | arti |
|------------------|-----------------------------------------|------|
| `hello`          | `hostId`, `resumeFrom`, `sessions[]`    | frame pertama setelah auth |
| `create_session` | `sessionId`, `cwd`, `title`, `auto`     | buat session baru |
| `set_auto`       | `sessionId`, `auto`                     | auto-approve semua tool |
| `set_model`      | `sessionId`, `model`                    | ganti model; `null` = default |
| `browse`         | `reqId`, `path`                         | daftar subdirektori di host |
| `prompt`         | `sessionId`, `text`                     | suntik prompt (owner sudah divalidasi hub) |
| `interrupt`      | `sessionId`                             | setara ESC |
| `approval_resp`  | `sessionId`, `reqId`, `decision`, `answers?` | `allow` \| `deny` \| `allow_always`; `answers` khusus `AskUserQuestion` |
| `close_session`  | `sessionId`                             | matikan proses, session jadi arsip |
| `ack`            | `sessionId`, `seq`                      | hub sudah tahan lama frame ≤ seq; agent boleh trim buffer |

`resumeFrom` adalah inti recovery. Setelah reconnect, agent mengirim ulang
semua frame ber-`seq` lebih besar dari nilai itu, **sebelum** frame baru.

### Kenapa `ack` hanya di batas giliran

Hub sengaja tidak meng-ack di tengah giliran. Live buffer hub (§4) dibangun
dengan memutar ulang delta dari `turn_start`; kalau agent boleh membuang frame
di tengah giliran, reconnect di detik ke-20 akan menghasilkan giliran yang
terpotong permanen dan tidak bisa direkonstruksi siapa pun.

Konsekuensinya buffer agent tumbuh sepanjang satu giliran, lalu kosong lagi.
Itu batas yang wajar — dan jauh lebih murah daripada transcript rusak.

### Kenapa `hello` membawa daftar session

`create_session` dikirim sekali dan tidak dijamin sampai — kalau agent sedang
offline saat session dibuat, pesan itu hilang dan session jadi mati permanen:
ada di sidebar, tapi prompt ke sana cuma menghasilkan diam.

Karena itu `hello` membawa daftar lengkap session milik host, dan agent
mengisi apa pun yang belum dia punya. Ini sekaligus memulihkan agent yang
kehilangan `sessions.json` — session hidup lagi, walau tanpa
`claudeSessionId` sehingga konteks percakapan lamanya tidak ikut.

Hub juga menolak `new_session` saat host offline, jadi jalur normalnya tidak
pernah sampai ke situ. Rekonsiliasi adalah jaring pengaman untuk balapan yang
tetap mungkin terjadi.

### Kenapa prompt user diputar lewat agent

Hub tidak menulis pesan user langsung ke DB. Ia mengirim `prompt` ke agent,
dan agent yang meng-echo balik sebagai frame `user_msg` ber-`seq`. Terlihat
memutar, tapi ini yang menjaga `seq` punya satu otoritas tunggal. Kalau hub
menyisipkan seq-nya sendiri, seq itu akan bertabrakan dengan milik agent saat
replay setelah reconnect.

### Agent → Hub

| `t`               | field                                          | arti |
|-------------------|------------------------------------------------|------|
| `auth`            | `v`, `hostName`, `platform`, `agentVersion`     | frame pertama dari agent |
| `session_state`   | `sessionId`, `alive`, `claudeSessionId?`, `cwd` | lapor proses hidup/mati (juga saat reconnect) |
| `frame`           | `Frame`                                         | event stream |
| `browse_result`   | `reqId`, `result`                               | jawaban `browse` |
| `models`          | `models: ModelInfo[]`                           | model yang tersedia di host |
| `pong`            | —                                               | balasan heartbeat |

---

## 4. Browser ↔ Hub (`WS /ws?token=<userToken>`)

### Browser → Hub

| `t`           | field                              | catatan |
|---------------|------------------------------------|---------|
| `subscribe`   | `sessionId`                        | siapa pun yang punya akses baca |
| `unsubscribe` | `sessionId`                        | |
| `prompt`      | `sessionId`, `text`                | **owner saja** — divalidasi di hub |
| `interrupt`   | `sessionId`                        | owner saja |
| `approve`     | `sessionId`, `reqId`, `decision`, `answers?` | owner saja; `answers` khusus `AskUserQuestion` |
| `new_session` | `hostId`, `cwd`, `title`           | owner host saja, host wajib online |
| `set_auto`    | `sessionId`, `auto`                | owner saja |
| `set_model`   | `sessionId`, `model`               | owner saja |
| `browse`      | `hostId`, `path`                   | owner host saja |

### Hub → Browser

| `t`           | field                                       | catatan |
|---------------|---------------------------------------------|---------|
| `roster`      | `users[] → hosts[] → sessions[]`            | dikirim saat connect & saat berubah |
| `snapshot`    | `sessionId`, `messages`, `live`, `seq`      | balasan `subscribe` |
| `frame`       | `Frame` (sudah di-coalesce)                 | stream live |
| `host_status` | `hostId`, `online`                          | |
| `denied`      | `action`, `reason`                          | |

### Kenapa `snapshot` punya field `live`

Kasus yang paling sering lupa didesain, padahal justru inti fitur "lihat
session orang": viewer yang membuka session di detik ke-20 dari respons 30
detik. Tanpa `live`, dia hanya melihat 10 detik terakhir.

Hub menyimpan satu buffer in-memory per session berisi giliran yang **sedang
berjalan**, dan membuangnya saat `turn_end` (isinya sudah pindah ke DB).

---

## 5. Otorisasi

Ditegakkan di **hub**, bukan di UI. Tombol yang di-disable bukan kontrol akses.

| aksi              | siapa |
|-------------------|-------|
| baca transcript   | sesuai `sessions.visibility`: `private` (owner) / `team` (semua user login) / `public` |
| prompt, interrupt, approve, close | **owner session saja** |
| buat session      | owner dari host tersebut saja |

Batas ini disengaja dan bukan sekadar soal keamanan. Karena tiap agent memakai
subscription Claude milik pemilik laptop, membiarkan user lain mem-*prompt*
session orang berarti (a) mengeksekusi shell di mesin orang lain, dan (b)
membakar kuota subscription orang lain — yang melanggar ToS consumer.

Kolaborasi yang aman nanti: viewer mengirim *usulan* prompt yang harus
di-approve owner sebelum dieksekusi.

---

## 6. Liveness

- Hub kirim `ping` (WS ping frame) tiap 20 detik; 2× miss = host dianggap
  offline, `host_status` di-broadcast.
- Agent auto-reconnect dengan exponential backoff + jitter (1s → 30s).
- Session yang host-nya offline tetap **bisa dibaca** dari DB, tapi tidak bisa
  di-prompt. UI harus jujur soal ini (`○ Offline — MacBook Pro`), kalau tidak
  user akan mengetik prompt lalu bingung kenapa hening.

## 7. Close codes

| kode | arti |
|------|------|
| 4401 | token tidak valid |
| 4403 | token valid, tapi tidak berhak |
| 4426 | versi protokol tidak cocok |
| 4429 | terlalu banyak koneksi |

---

## 8. Pemilihan model

Daftar model **ditanyakan ke host**, tidak pernah ditebak hub: yang tersedia
bergantung pada akun dan versi CLI di laptop itu. Agent memanggil
`supportedModels()` — sebuah control request yang butuh proses Claude Code
hidup tapi **tidak melakukan inference sama sekali**, jadi gratis dari sisi
token (~2 detik spawn).

Hasilnya di-cache ke `~/.company-agent/models.json` dan dikirim lebih dulu saat
`hello`, supaya UI langsung terisi; enumerasi ulang jalan di belakang untuk
menangkap perubahan tanpa menahan startup.

Penerapannya dua jalur, tergantung session sedang hidup atau tidak:

| kondisi | cara |
|---------|------|
| proses hidup | `Query.setModel()` — berpindah saat itu juga, tanpa restart |
| session cold | disimpan saja, dipakai lewat `options.model` saat spawn berikutnya |

Satu jebakan saat menguji ini: **jangan percaya model menyebut namanya
sendiri.** Dalam satu percakapan yang sudah berjalan, model cenderung meniru
jawaban giliran sebelumnya, jadi setelah pindah dari Opus ke Haiku ia masih
menjawab "Opus". Bukti yang benar ada di `modelUsage` pada pesan `result`
(sifatnya kumulatif — model baru muncul sebagai key tambahan), atau uji dengan
session yang benar-benar baru.

## 9. Auto mode

`set_auto` membuat `canUseTool` di agent langsung mengizinkan setiap tool
tanpa menunggu owner. Nilainya per-session, tersimpan di DB hub dan di
`sessions.json` agent, jadi bertahan lintas restart keduanya.

Yang **tidak** berubah: setiap tool call tetap muncul di transcript lengkap
dengan input dan hasilnya. Auto mode menghapus kesempatan menolak, bukan
jejaknya — viewer tetap melihat persis apa yang dijalankan.

Owner saja yang boleh mengubahnya, dan status `auto on` ditampilkan ke semua
viewer supaya tidak ada session yang diam-diam berjalan tanpa pengawasan.

---

## 10. Device-code pairing (HTTP, di luar WS)

Agent tidak pernah menyentuh kredensial user, dan user tidak pernah menyalin
token panjang.

```
agent                     hub                        browser (user login)
  │  POST /pair/start      │                                │
  │───────────────────────►│  simpan pending, TTL 5 menit   │
  │◄── {code, pollToken} ──│                                │
  │                        │                                │
  │  (tampilkan code)      │      POST /pair/claim {code}   │
  │                        │◄───── Bearer <userToken> ──────│
  │                        │  buat host row + hostToken     │
  │  POST /pair/poll       │                                │
  │───────────────────────►│                                │
  │◄─ {hostId, hostToken} ─│  sekali ambil, lalu dibuang    │
```

Klaim **wajib** atas nama user yang sudah login: klaim itulah yang mengikat
laptop ke sebuah akun, dan pemegang akun itu nanti bisa menjalankan shell di
laptop tersebut. Karena itu kode pendek dilindungi berlapis:

| lapis | nilai |
|-------|-------|
| TTL | 5 menit |
| sekali pakai | pending dihapus begitu agent mengambil token |
| alfabet | 31 huruf, ambigu (`0O1IL`) dibuang, 8 karakter |
| rate limit | 10 percobaan klaim per user per 10 menit |
| pencocokan | waktu-konstan atas semua kode aktif |

`pollToken` adalah rahasia panjang milik agent — itu yang mengikat hasil poll
ke agent yang benar, bukan kode pendeknya.

### Satu koneksi per host

Hub menutup koneksi lama dengan close code 4429 saat host yang sama
menyambung lagi, dan agent yang menerima 4429 **berhenti total** alih-alih
reconnect. Tanpa aturan kedua itu, dua agent dengan token yang sama akan
saling menendang tanpa henti — dan gejalanya menyesatkan: session tampak
hidup, tapi `seq` dari kedua agent bertabrakan sehingga hub membuang frame
sebagai duplikat dan session diam total tanpa satu pun error.
