# 🦁 SirLion Audio Studio v1.9.0

**Spoof → Edit → Convert → Upload → Generate Script.** Semua dalam satu web.

## Alur pakai

1. **Spoof ID** — masukkan ID audio publik → `🔍 Spoof & Preview`.
2. **Panel kontrol** muncul: Play/Pause + progress, slider **Speed** (0.5–2x), **Pitch** (−12…+12 st), **Volume** (0–200%), semua real-time (Web Audio API).
3. **Format** MP3/OGG/WAV → **🔄 Convert** (backend ffmpeg: `atempo` + `rubberband` + `volume` + transcode).
4. **🚀 Upload & Pantau Moderasi** — convert otomatis lalu upload via Open Cloud. ID baru langsung tampil, tetapi tidak dianggap approved sebelum status resmi Roblox berubah menjadi Approved; halaman memeriksa status otomatis setiap 15 detik.
5. **📚 Antrean Upload Manual** — pilih 1–10 file MP3/OGG/WAV/FLAC ke website terlebih dahulu, atur speed/pitch/volume/format seperti biasa, lalu satu tombol menerapkan pengaturan yang sama dan mengupload seluruh antrean ke Roblox. Setiap musik menampilkan Asset ID dan status moderasinya sendiri.
6. **🕺 Spoof Animasi** — cari Animation publik atau masukkan ID → download RBXM resmi → reupload ke akun/grup pengguna.
7. **📦 Upload Model** — pilih `.rbxm`/`.rbxmx` → upload sebagai Model/package ke akun/grup pengguna.
8. **📜 Generate Script** — Lua client/server/GUI + syntax highlight + copy/download.

Upload audio maupun animasi butuh kredensial (API key `asset:read` + `asset:write`, User ID). Spoof + preview + convert **tanpa key**.

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
| GET | `/api/search-animation?keyword=&limit=` | Cari Animation publik di Creator Store |
| POST | `/api/reupload-animation/:id` | Download RBXM publik → upload sebagai Animation baru |
| GET | `/api/asset-status/:id` | Baca status moderasi resmi asset milik pengguna dengan `asset:read` |
| POST | `/api/grant-audio-collaborator` | Berikan izin Use satu audio ke User ID/username |
| POST | `/api/grant-audio-collaborators-bulk` | Berikan izin Use hingga 100 audio per panggilan internal ke satu User ID |
| POST | `/api/upload-model` | Upload file RBXM/RBXMX sebagai Model/package baru |

## Kolaborator Audio 👤

Tempel banyak Asset ID audio serta banyak User ID tujuan menggunakan koma, spasi,
atau baris baru. Aplikasi memberikan izin **Use** untuk setiap kombinasi asset × user.
UI tidak menetapkan batas total; asset dipecah menjadi kelompok 100 dan tujuan diproses
berurutan dengan jeda agar menghormati rate-limit Roblox. Batch besar mengharuskan tab
browser tetap terbuka dan dapat tetap dibatasi oleh kuota API Roblox. API Key Utama
memerlukan scope **asset-permissions:write** selain `asset:read`. Setiap penerima
individual harus sudah menjadi teman pemilik asset. Aplikasi tidak menggunakan
`.ROBLOSECURITY`.

## Upload Model RBXM 📦

Panel upload manual menerima `.rbxm` dan `.rbxmx` hingga 20 MB, memvalidasi header
file Roblox, lalu menguploadnya dengan `assetType: Model` melalui Open Cloud.
Target akun atau grup mengikuti panel Kredensial. Roblox memproses Model RBXM sebagai
model/package. Selalu periksa Script yang terdapat di model sebelum digunakan di game.

## Spoof Animasi 🕺

Panel terpisah dengan pintasan **Dance / Emote / Idle**, pencarian berdasarkan nama,
atau ID Animation langsung. Tombol **Reupload** mengambil source `.rbxm` resmi,
memindainya dengan parser RBXM berlisensi MIT, menghapus hanya attribute
`MaxPartTranslation`, mendeteksi rig R6/R15, lalu membuat Animation baru melalui
Open Cloud Assets API.

- Kredensial menyediakan **dua kolom API key terpisah** agar izin audio/model tidak
  bercampur dengan animasi. Key utama dipakai hanya untuk Audio & Model; key khusus
  animasi dipakai hanya untuk pencarian, download, dan reupload Animation.
- Key khusus animasi harus memiliki **assets: asset:read + asset:write** dan
  **legacy-assets: legacy-asset:manage**. Tombol **Tes Animasi** memeriksa endpoint
  Asset Delivery yang membutuhkan izin legacy; tanpa itu Roblox membalas 403.
- Target dapat berupa akun pengguna atau grup sesuai Kredensial.
- Hanya ID bertipe Animation (`AssetTypeId 24`) yang diterima.
- Maksimum file 20 MB sesuai batas Open Cloud.
- Hasil pencarian memeriksa Asset Delivery: tombol Reupload hanya aktif bila source RBXM tersedia.
- Status Public Domain tidak selalu berarti source RBXM boleh diunduh; ID asli masih dapat dipakai bila diizinkan.
- Gunakan hanya animasi milikmu, public domain, atau yang diizinkan untuk disalin.

### Tentang R6 / R15

Versi ini **mendeteksi** rig sumber dan menampilkannya di hasil. Konversi transform
R6↔R15 belum diaktifkan: kedua rig mempunyai hierarchy joint berbeda, sehingga
sekadar mengganti nama Pose dapat merusak gerakan. Aplikasi tidak mengklaim dapat
mengonversi semua animasi secara sempurna.

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
