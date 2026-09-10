# 🦁 SirLion Audio Studio v1.2.0

**Spoof → Edit → Convert → Upload → Generate Script.** Semua dalam satu web.

## Alur pakai

1. **Spoof ID** — masukkan ID audio publik → `🔍 Spoof & Preview`.
2. **Panel kontrol** muncul: Play/Pause + progress, slider **Speed** (0.5–2x), **Pitch** (−12…+12 st), **Volume** (0–200%), semua real-time (Web Audio API).
3. **Format** MP3/OGG/WAV → **🔄 Convert** (backend ffmpeg: `atempo` + `rubberband` + `volume` + transcode).
4. **🚀 Upload Ulang (Instant Approve!)** — convert otomatis dulu bila pengaturan berubah, lalu upload via Open Cloud. ID baru langsung tampil + tombol Copy & Generate Script.
5. **📜 Generate Script** — Lua client/server/GUI + syntax highlight + copy/download.

Upload butuh kredensial (API key `asset:read` + `asset:write`, User ID). Spoof + preview + convert **tanpa key**.

## Cara jalanin

```bash
cd sirlion-studio
npm install        # termasuk ffmpeg-static (±30 MB binary, otomatis)
cp .env.example .env
npm start          # buka http://localhost:3000 (butuh Node.js 18+)
```

> Tanpa ffmpeg (mis. install gagal): `CONVERT` MP3/OGG nonaktif, tapi browser otomatis fallback render **WAV** — upload tetap jalan.

## Deploy ke Railway 🚂

1. Push folder ini ke GitHub, lalu **New Project → Deploy from Repo** di Railway
   (atau hubungkan repo yang sudah ada → Railway auto-redeploy tiap push).
2. Pasang ffmpeg — pilih salah satu:
   - **Railpack** (builder baru): Variables → tambah `RAILPACK_PACKAGES` = `ffmpeg`
   - **Nixpacks**: file `nixpacks.toml` di repo ini otomatis dipakai
   - Kalau keduanya gagal, server otomatis self-install ffmpeg-static resmi ke
     folder temporary saat boot.
3. Verifikasi: buka `https://xxx.up.railway.app/api/health` — pastikan
   `"ffmpeg": true`. Kalau false, baca `bins.ffmpeg.error` untuk penyebabnya.
4. Start command default (`npm start`) + port otomatis (`process.env.PORT`) —
   tidak perlu setting lain.

## Cara kerja spoof (backend)

```
GET /api/spoof-audio/:id
 ├─ 1. assetdelivery v1 (302 → CDN gzip)      [jalur utama, sesuai spek]
 ├─ 2. assetdelivery v2 (JSON → signed URL)
 └─ 3. Open Cloud asset-delivery-api + API key (audio milikmu / diizinkan)
 + GET /api/spoof-info/:id → nama artis/judul (economy → fallback toolbox)
```

- Default mengembalikan **binary audio** (cepat, tanpa overhead base64).
- `?as=json` mengembalikan `{ name, format, size, dataUrl }` sesuai spek.
- Setiap kandidat divalidasi magic-bytes (`OggS`, `ID3`, `RIFF/WAVE`, `fLaC`) + auto-gunzip.

## API

| Method | Endpoint | Fungsi |
|--------|----------|--------|
| GET | `/api/health` | Status + `ffmpeg: true/false` |
| POST | `/api/check-key` | Tes API key + user (+ grup) |
| GET | `/api/spoof-info/:id` | Nama/kreator/tipe asset |
| GET | `/api/spoof-audio/:id[?as=json]` | Binary audio / JSON+base64 |
| POST | `/api/convert` (`file`+`speed`+`pitch`+`volume`+`format`) | Render efek + transcode → binary |
| POST | `/api/upload` (`file`+`name`, header kredensial) | Upload Open Cloud + polling Operation |
| POST | `/api/generate-script` | Lua client/server/gui |
| GET | `/api/search-audio?keyword=&limit=` | Cari salinan publik (dengan skor relevansi) |
| POST | `/api/import-url` (`{url}`) | Ambil file audio dari link langsung |
| POST | `/api/diagnose-access` (`{assetId}`, header key) | Diagnosa langkah-demi-langkah kenapa key ditolak |
| GET | `/api/spoof-smart/:id` | ID privat → otomatis pakai salinan publik yang bunyi (dipakai otomatis saat spoof biasa gagal) |
## Kenapa tool lain "bisa" download privat? (cookie + placeId) 🍪

Hasil bedah source code open-source (kartFr/Asset-Reuploader) + situs Harmless
("your Roblox cookies are stored on your device"): mereka memakai **cookie login
`.ROBLOSECURITY` + `placeId`** ke `POST assetdelivery/.../v2/assets/batch`.
Bot Discord polanya sama (pakai akun/cookie host-nya).

Batasan yang jarang dibilang: cookie pun **TIDAK bisa** mengambil audio privat
milik orang asing tanpa grant — hanya yang boleh diakses akun + place itu.

App ini **sengaja tidak memakai cara cookie** — meminta/menempel cookie adalah cara #1
akun Roblox dicuri (jangan pernah tempel cookie-mu ke tool apa pun!). Sebagai gantinya:

1. `spoof-smart` otomatis memakai **salinan publik lagu yang sama**,
2. Opsi **🌐 Download via browser-mu**: buka link assetdelivery resmi di tab baru —
   browser-mu yang sudah login yang download (cookie tidak pernah keluar browser).
   Kalau ke-download → upload file-nya via tombol 📁. Kalau 403 → akunmu pun
   tidak punya akses ke ID itu.

## "Link store bisa bunyi, kok app gagal?" 🔓

Browser-mu login sebagai akunmu (cookie) — app memakai API key-mu. Kalau keduanya
tidak setara haknya, ya satu bisa satu gagal. Penyebab #1: **scope `asset:read`
belum aktif di key-mu**. Klik **🔓 Diagnosa kenapa key-mu ditolak** di panel
penyelamat — app akan membuktikan langkah demi langkah (key valid? punya
asset:read? download tembus?) + cara betulinnya.

## Kalau kena ID privat 🔒

Roblox mengunci byte audio privat di sisi server (`403 User is not authorized`) —
**tidak ada tool yang bisa mengambilnya tanpa izin pemilik**. Sebagai gantinya app
otomatis membuka **panel penyelamat**:

1. 🔎 **Cari versi publik lagu yang sama** (otomatis pakai judulnya!) + tombol 🎤 cari karya artisnya
2. 🔗 **Tempel link file audio langsung** (`.mp3`/`.ogg`/`.wav` — bukan link YouTube/Spotify)
3. 📁 **Upload file sendiri**

Ketiganya masuk ke pipeline studio yang sama: edit → convert → upload → script.

## Batasan Roblox (bukan bug)

- Audio maks **7 menit / 20 MB**; format MP3/OGG/WAV/FLAC.
- Jatah upload ±10/bln (ID-verified ±100/bln); error `429` = tunggu 1–2 menit.
- Audio **privat orang lain** tidak bisa di-spoof (aturan Roblox).
- Hasil upload privat di `Creator Dashboard → Development Items → Audio`.
