// server.js — SirLion Uploader v2.1 (FIXED)
// Upload audio MILIK SENDIRI ke Roblox via Open Cloud API (resmi).
// Audio yang diupload masuk moderasi & tercatat privat di:
// Creator Dashboard → Development Items → Audio
//
// Perbaikan dari v2:
//  [1] Tambah route POST /api/check-key (dipakai tombol "Tes Kredensial", sebelumnya 404)
//  [2] Endpoint download dibetulkan: GET https://apis.roblox.com/asset-delivery-api/v1/assetId/{id}
//      (endpoint lama /assets/v1/assets/{id}:download tidak ada → selalu 404)
//  [3] Polling Operation: Create Asset mengembalikan { path: "operations/xxx" } yang harus
//      di-poll ke GET /assets/v1/operations/{id} sampai done:true baru assetId keluar
//  [4] Validasi MIME longgar + fallback ekstensi + sniffing magic-bytes + MIME kanonis
//      (audio/mpeg, audio/ogg, audio/wav, audio/flac sesuai dokumentasi Roblox)
//  [5] Error handler multer (file >20MB) & global agar selalu balas JSON, bukan halaman HTML
//  [6] Timeout tiap request ke Roblox + pesan error Indonesia yang jelas (401/403/404/429)
//  [7] /api/asset-info punya fallback bila endpoint economy gagal
//  [8] /api/search-audio: baca flag isFree dari path yang benar + info vote

const express = require('express');
const cors = require('cors');
const multer = require('multer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const UA = { 'User-Agent': 'SirLion-Uploader/2.1' };

// Audio: maks 20 MB per request (aturan Open Cloud), durasi maks 7 menit (aturan Roblox)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

// MIME apa pun yang dikirim browser → ekstensi Roblox. MIME kanonis ikut tabel dokumentasi:
// mp3→audio/mpeg · ogg→audio/ogg · wav→audio/wav · flac→audio/flac
const MIME_TO_EXT = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/x-mpeg': 'mp3', 'audio/mpg': 'mp3',
  'audio/ogg': 'ogg', 'audio/x-ogg': 'ogg', 'application/ogg': 'ogg',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/x-wave': 'wav', 'audio/vnd.wave': 'wav',
  'audio/flac': 'flac', 'audio/x-flac': 'flac'
};
const EXT_TO_CANONICAL_MIME = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac' };

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// ============================================================
// HELPERS
// ============================================================
function getCreds(req) {
  return {
    apiKey: (req.headers['x-api-key'] || process.env.ROBLOX_API_KEY || '').trim(),
    userId: (req.headers['x-user-id'] || process.env.ROBLOX_USER_ID || '').trim(),
    groupId: (req.headers['x-group-id'] || process.env.ROBLOX_GROUP_ID || '').trim()
  };
}

// Tebak ekstensi dari isi file (magic bytes) — dipakai saat content-type tidak jelas
function sniffAudioExt(buf) {
  if (!buf || buf.length < 12) return null;
  const ascii4 = buf.subarray(0, 4).toString('ascii');
  const ascii12 = buf.subarray(8, 12).toString('ascii');
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'mp3'; // ID3
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';           // frame sync
  if (ascii4 === 'OggS') return 'ogg';
  if (ascii4 === 'RIFF' && ascii12 === 'WAVE') return 'wav';
  if (ascii4 === 'fLaC') return 'flac';
  return null;
}

// Tentukan ekstensi + MIME kanonis dari MIME browser dan/atau nama file
function resolveAudioFormat(mimetype, filename) {
  const mime = String(mimetype || '').split(';')[0].trim().toLowerCase();
  let ext = MIME_TO_EXT[mime] || null;
  if (!ext && filename) {
    const m = String(filename).toLowerCase().match(/\.([a-z0-9]+)$/);
    if (m && EXT_TO_CANONICAL_MIME[m[1]]) ext = m[1];
  }
  if (!ext) return null;
  return { ext, mime: EXT_TO_CANONICAL_MIME[ext] };
}

function extractAssetId(op) {
  if (!op || typeof op !== 'object') return null;
  if (op.response && op.response.assetId) return String(op.response.assetId);
  if (op.response && op.response.path) return String(op.response.path).split('/').pop();
  if (op.assetId) return String(op.assetId);
  if (op.metadata && op.metadata.assetId) return String(op.metadata.assetId);
  if (typeof op.path === 'string' && op.path.startsWith('assets/')) return op.path.split('/').pop();
  return null;
}

// Poll GET /assets/v1/operations/{id} sampai done:true (maks ~60 detik)
async function pollOperation(apiKey, operationPath, { tries = 30, intervalMs = 2000 } = {}) {
  const opId = String(operationPath).split('/').pop();
  const url = `https://apis.roblox.com/assets/v1/operations/${opId}`;
  let last = null;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(15000)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || `Gagal cek status upload (${r.status}).`);
    last = data;
    if (data.done === true) return data;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const err = new Error(
    'Upload masih diproses Roblox setelah ±60 detik. Cek Creator Dashboard → Development Items → Audio — kalau audionya muncul, pakai ID dari sana.'
  );
  err.code = 'OPERATION_TIMEOUT';
  err.operation = last;
  throw err;
}

// Upload 1 buffer audio ke Roblox, kembalikan { assetId, operation }
async function createAudioAsset({ apiKey, userId, groupId, buffer, mime, ext, displayName, description }) {
  const metadata = {
    assetType: 'Audio',
    displayName: String(displayName).slice(0, 50),
    description: String(description || '').slice(0, 200),
    creationContext: {
      creator: groupId ? { groupId: String(groupId) } : { userId: String(userId) }
    }
  };

  const form = new FormData();
  form.append('request', JSON.stringify(metadata));
  form.append('fileContent', new Blob([buffer], { type: mime }), `audio.${ext}`);

  const r = await fetch('https://apis.roblox.com/assets/v1/assets', {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    body: form,
    signal: AbortSignal.timeout(120000)
  });
  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    throw Object.assign(
      new Error(humanizeCreateError(r.status, data)),
      { status: r.status, details: data }
    );
  }

  // Langsung jadi? (jarang) — umumnya harus poll Operation dulu
  let op = data;
  if (!data.done && data.path && String(data.path).startsWith('operations/')) {
    op = await pollOperation(apiKey, data.path);
  }
  if (op.error) {
    throw Object.assign(
      new Error(`Roblox menolak upload: ${op.error.message || JSON.stringify(op.error)}`),
      { details: op }
    );
  }
  const assetId = extractAssetId(op);
  if (!assetId) {
    throw Object.assign(
      new Error('Upload terkirim tapi ID aset tidak terbaca dari respons Roblox.'),
      { details: op }
    );
  }
  return { assetId, operation: op };
}

function humanizeCreateError(status, data) {
  const msg = (data && data.message) || '';
  if (status === 401) return 'API Key tidak valid / kedaluwarsa (401). Buat key baru di Creator Dashboard → Credentials.';
  if (status === 403) {
    if (/quota/i.test(msg)) return `Jatah upload audio habis (403): ${msg} (Maks ±10/bln, atau ±100/bln jika ID-verified.)`;
    return `Roblox menolak (403): ${msg || 'API key tidak punya izin asset:write, atau IP tidak ada di allowlist.'}`;
  }
  if (status === 429) return 'Kena rate-limit Roblox (429). Tunggu 1–2 menit lalu coba lagi.';
  if (status === 400) return `Request ditolak Roblox (400): ${msg || 'cek format file / nama / creator.'}`;
  return msg || `Roblox API error (${status}).`;
}

// Download isi audio: endpoint Open Cloud yang benar + fallback publik
async function downloadAssetBuffer(apiKey, assetId) {
  const ocUrl = `https://apis.roblox.com/asset-delivery-api/v1/assetId/${assetId}`;
  let lastError = '';

  try {
    const r = await fetch(ocUrl, {
      headers: { 'x-api-key': apiKey, Accept: '*/*' },
      signal: AbortSignal.timeout(60000)
    });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (r.ok && !ct.includes('json')) {
      return { buffer: Buffer.from(await r.arrayBuffer()), contentType: ct };
    }
    const body = await r.text().catch(() => '');
    lastError = `Open Cloud (${r.status}): ${body.slice(0, 200) || r.statusText}`;
    if (r.status === 401) throw new Error('API Key tidak valid (401).');
    if (r.status === 403) throw new Error(
      'Roblox tidak mengizinkan download audio ini dengan API key-mu (403). Hanya audio milikmu / yang izinnya dibuka yang bisa di-download — audio privat orang lain pasti ditolak.'
    );
    if (r.status === 404) throw new Error('Asset tidak ditemukan / bukan audio (404).');
  } catch (e) {
    if (e instanceof Error && /^(API Key|Roblox tidak|Asset tidak)/.test(e.message)) {
      // 401/403/404 dari Open Cloud = jawaban final, tapi 403/404 masih boleh coba jalur publik
      if (/^API Key/.test(e.message)) throw e;
      lastError = e.message;
    } else if (e?.name === 'TimeoutError') {
      lastError = 'Timeout menghubungi Roblox.';
    } else {
      lastError = e?.message || String(e);
    }
  }

  // Fallback: endpoint publik (hanya untuk aset publik; sering sudah dimatikan Roblox)
  try {
    const pub = await fetch(`https://assetdelivery.roblox.com/v2/assetId/${assetId}`, {
      headers: UA,
      signal: AbortSignal.timeout(60000)
    });
    const ct = (pub.headers.get('content-type') || '').toLowerCase();
    if (pub.ok && !ct.includes('json')) {
      return { buffer: Buffer.from(await pub.arrayBuffer()), contentType: ct };
    }
  } catch { /* abaikan, pakai error Open Cloud */ }

  throw new Error(lastError || 'Gagal download audio dari Roblox.');
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({
    status: '🦁 SirLion Uploader running!',
    version: '2.1.0',
    node: process.version,
    timestamp: new Date().toISOString()
  });
});

// ============================================================
// TES KREDENSIAL (dipakai tombol "Tes Kredensial" di web)
// Body: { apiKey, userId (boleh username), groupId? }
// Balasan: { success, ok, report: [{ ok, msg, resolvedId? }] }
// ============================================================
app.post('/api/check-key', async (req, res) => {
  try {
    const apiKey = String(req.body.apiKey || '').trim();
    const userInput = String(req.body.userId || '').trim();
    const groupId = String(req.body.groupId || '').trim();
    const report = [];

    if (!apiKey) return res.status(400).json({ success: false, error: 'API Key wajib diisi!' });
    if (!userInput) return res.status(400).json({ success: false, error: 'User ID / username wajib diisi!' });

    // 1) User ID valid? (atau resolve username → ID)
    let resolvedId = null;
    try {
      if (/^\d+$/.test(userInput)) {
        const u = await fetch(`https://users.roblox.com/v1/users/${userInput}`, {
          headers: UA, signal: AbortSignal.timeout(15000)
        });
        if (u.ok) {
          const j = await u.json();
          resolvedId = String(j.id);
          report.push({ ok: true, msg: `✅ User ID valid: ${j.name} (${j.id})`, resolvedId });
        } else {
          report.push({ ok: false, msg: `❌ User ID ${userInput} tidak ditemukan (status ${u.status}).` });
        }
      } else {
        const u = await fetch('https://users.roblox.com/v1/usernames/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...UA },
          body: JSON.stringify({ usernames: [userInput], excludeBannedUsers: false }),
          signal: AbortSignal.timeout(15000)
        });
        const j = await u.json().catch(() => ({}));
        if (j.data && j.data[0]) {
          resolvedId = String(j.data[0].id);
          report.push({ ok: true, msg: `✅ Username "${userInput}" → User ID ${resolvedId} (otomatis diisi)`, resolvedId });
        } else {
          report.push({ ok: false, msg: `❌ Username "${userInput}" tidak ditemukan.` });
        }
      }
    } catch (e) {
      report.push({ ok: false, msg: `❌ Gagal cek user: ${e.message}` });
    }

    // 2) API key valid? (panggilan ringan berautentikasi)
    let keyOk = false;
    try {
      const q = await fetch('https://apis.roblox.com/assets/v1/assets/1', {
        headers: { 'x-api-key': apiKey },
        signal: AbortSignal.timeout(15000)
      });
      if (q.status === 401) {
        report.push({ ok: false, msg: '❌ API Key TIDAK VALID (401). Cek key di Credentials — pastikan key aktif & IP-mu ada di allowlist.' });
      } else if (q.ok) {
        keyOk = true;
        report.push({ ok: true, msg: '✅ API Key valid + bisa baca metadata (asset:read OK).' });
      } else if (q.status === 403) {
        keyOk = true; // key valid, tapi scope/izin kurang
        report.push({ ok: true, msg: '⚠️ API Key valid, tapi ditolak baca metadata (403). Pastikan permission asset:read + asset:write AKTIF dan creator-nya benar.' });
      } else if (q.status === 429) {
        report.push({ ok: false, msg: '❌ Kena rate-limit Roblox (429). Tunggu sebentar lalu tes lagi.' });
      } else {
        keyOk = true;
        report.push({ ok: true, msg: `⚠️ API Key merespons (${q.status}) — kemungkinan valid. Lanjut tes upload file kecil.` });
      }
    } catch (e) {
      report.push({ ok: false, msg: `❌ Tidak bisa menghubungi Roblox: ${e.message}` });
    }

    // 3) Group ID (opsional)
    let groupOk = true;
    if (groupId) {
      if (!/^\d+$/.test(groupId)) {
        groupOk = false;
        report.push({ ok: false, msg: '❌ Group ID harus angka.' });
      } else {
        try {
          const g = await fetch(`https://groups.roblox.com/v1/groups/${groupId}`, {
            headers: UA, signal: AbortSignal.timeout(15000)
          });
          if (g.ok) {
            const j = await g.json();
            report.push({ ok: true, msg: `✅ Group valid: ${j.name} (${j.id}). Upload akan tercatat atas nama grup.` });
          } else {
            groupOk = false;
            report.push({ ok: false, msg: `❌ Group ID ${groupId} tidak ditemukan (status ${g.status}).` });
          }
        } catch (e) {
          groupOk = false;
          report.push({ ok: false, msg: `❌ Gagal cek grup: ${e.message}` });
        }
      }
    }

    res.json({ success: true, ok: Boolean(resolvedId && keyOk && groupOk), report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Gagal tes kredensial' });
  }
});

// ============================================================
// UPLOAD FILE AUDIO → ROBLOX OPEN CLOUD
// ============================================================
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const { apiKey, userId, groupId } = getCreds(req);

    if (!apiKey || !userId) {
      return res.status(400).json({
        success: false,
        error: 'API Key dan User ID wajib diisi! (isi di web lalu Simpan, atau set di .env)'
      });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Pilih file audio dulu!' });
    }

    const fmt = resolveAudioFormat(req.file.mimetype, req.file.originalname)
      || (() => { const ext = sniffAudioExt(req.file.buffer); return ext ? { ext, mime: EXT_TO_CANONICAL_MIME[ext] } : null; })();

    if (!fmt) {
      return res.status(400).json({
        success: false,
        error: `Format "${req.file.mimetype || 'tidak diketahui'}" tidak didukung. Pakai MP3, OGG, WAV, atau FLAC (maks 7 menit / 20 MB).`
      });
    }

    const name = (req.body.name || req.file.originalname.replace(/\.[^.]+$/, '')).trim().slice(0, 50) || 'My Audio';
    console.log(`📤 Uploading "${name}" (${(req.file.size / 1024 / 1024).toFixed(2)} MB, ${fmt.ext})...`);

    const { assetId, operation } = await createAudioAsset({
      apiKey, userId, groupId: groupId || null,
      buffer: req.file.buffer, mime: fmt.mime, ext: fmt.ext,
      displayName: name, description: 'Uploaded via SirLion Uploader'
    });

    console.log(`✅ Sukses! ID baru: ${assetId}`);

    res.json({
      success: true,
      newAssetId: assetId,
      name,
      size: `${(req.file.size / 1024 / 1024).toFixed(2)} MB`,
      format: fmt.ext.toUpperCase(),
      url: `rbxassetid://${assetId}`,
      moderation: operation?.response?.moderationResult?.moderationState || null,
      message: `✅ Berhasil! Audio kamu live (privat) dengan ID baru: ${assetId}`
    });
  } catch (error) {
    console.error('❌ Upload error:', error.message);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Gagal upload audio',
      ...(error.details ? { details: error.details } : {})
    });
  }
});

// ============================================================
// UPLOAD ID (SPOOF): download resmi → upload ulang sebagai aset baru
// Izin sepenuhnya ditentukan Roblox: hanya audio milikmu / yang
// izinnya dibuka untuk API key-mu yang bisa didownload.
// ============================================================
app.post('/api/spoof-upload', async (req, res) => {
  try {
    const { assetId } = req.body || {};
    const { apiKey, userId, groupId } = getCreds(req);

    if (!apiKey || !userId) {
      return res.status(400).json({ success: false, error: 'API Key dan User ID diperlukan! (isi & simpan kredensial dulu)' });
    }
    if (!assetId || !/^\d+$/.test(String(assetId))) {
      return res.status(400).json({ success: false, error: 'Asset ID tidak valid! Harus angka.' });
    }

    console.log(`🔄 Spoof-upload asset ID: ${assetId}`);

    // STEP 1: nama audio (agar displayName ikut aslinya)
    let audioName = `Audio_${assetId}`;
    try {
      const info = await fetch(`https://economy.roblox.com/v2/assets/${assetId}/details`, {
        headers: UA, signal: AbortSignal.timeout(15000)
      });
      if (info.ok) {
        const j = await info.json();
        if (j.Name) audioName = j.Name;
      }
    } catch { /* nama default */ }

    // STEP 2: download resmi (endpoint Open Cloud yang benar)
    const { buffer: buf, contentType } = await downloadAssetBuffer(apiKey, String(assetId));

    if (buf.length < 1000) {
      return res.status(400).json({ success: false, error: 'File audio kosong / terlalu kecil (bukan audio valid).' });
    }
    if (buf.length > 20 * 1024 * 1024) {
      return res.status(400).json({ success: false, error: 'Audio hasil download >20 MB — melebihi batas upload Roblox.' });
    }

    let ext = (resolveAudioFormat(contentType, '') || {}).ext || sniffAudioExt(buf);
    if (!ext) {
      return res.status(400).json({
        success: false,
        error: 'Isi file bukan audio MP3/OGG/WAV/FLAC yang dikenali. (Mungkin ID-nya bukan audio, atau Roblox mengembalikan halaman error.)'
      });
    }
    console.log(`✅ Downloaded: ${(buf.length / 1024 / 1024).toFixed(2)} MB (${ext})`);

    // STEP 3: upload ulang sebagai aset baru milikmu
    const { assetId: newAssetId, operation } = await createAudioAsset({
      apiKey, userId, groupId: groupId || null,
      buffer: buf, mime: EXT_TO_CANONICAL_MIME[ext], ext,
      displayName: audioName, description: 'Re-upload via SirLion Uploader'
    });

    console.log(`✅ Spoof sukses: ${assetId} → ${newAssetId}`);
    res.json({
      success: true,
      originalAssetId: String(assetId),
      newAssetId,
      name: audioName,
      size: `${(buf.length / 1024 / 1024).toFixed(2)} MB`,
      format: ext.toUpperCase(),
      url: `rbxassetid://${newAssetId}`,
      moderation: operation?.response?.moderationResult?.moderationState || null
    });
  } catch (error) {
    console.error('❌ Spoof error:', error.message);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Gagal spoof & upload',
      ...(error.details ? { details: error.details } : {})
    });
  }
});

// ============================================================
// STREAM AUDIO (play langsung di web — butuh API key)
// ============================================================
app.get('/api/audio-stream/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) return res.status(400).json({ success: false, error: 'ID tidak valid' });
  const { apiKey } = getCreds(req);
  if (!apiKey) {
    return res.status(400).json({
      success: false,
      error: 'Butuh API key (isi di bagian 🔑 Kredensial) untuk memutar audio langsung di web. Tanpa key, Roblox tidak mengizinkan akses file audio.'
    });
  }
  try {
    const { buffer, contentType } = await downloadAssetBuffer(apiKey, id);
    const ext = sniffAudioExt(buffer);
    res.setHeader('Content-Type', (ext && EXT_TO_CANONICAL_MIME[ext]) || contentType || 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Gagal stream audio' });
  }
});

// ============================================================
// CARI LAGU DI CREATOR STORE (publik, tanpa API key)
// ============================================================
app.get('/api/search-audio', async (req, res) => {
  const keyword = (req.query.keyword || '').trim();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 20);
  if (!keyword) return res.status(400).json({ success: false, error: 'Ketik judul lagu dulu!' });

  try {
    const sr = await fetch(
      `https://apis.roblox.com/toolbox-service/v1/marketplace/3?keyword=${encodeURIComponent(keyword)}&limit=${limit}&sortType=Relevance&audioTypes=Music`,
      { headers: UA, signal: AbortSignal.timeout(20000) }
    );
    if (!sr.ok) {
      const msg = sr.status === 429
        ? 'Kena rate-limit Roblox (429). Tunggu sebentar lalu coba lagi.'
        : `Roblox search error (${sr.status}).`;
      return res.status(sr.status).json({ success: false, error: msg });
    }
    const sdata = await sr.json();
    const ids = (sdata.data || []).map((x) => x.id).filter(Boolean);
    if (!ids.length) return res.json({ success: true, keyword, total: 0, results: [] });

    const dr = await fetch(
      `https://apis.roblox.com/toolbox-service/v1/items/details?assetIds=${ids.join(',')}`,
      { headers: UA, signal: AbortSignal.timeout(20000) }
    );
    const ddata = await dr.json().catch(() => ({ data: [] }));

    const results = (ddata.data || [])
      .filter((item) => item.asset && item.asset.typeId === 3)
      .map((item) => {
        const a = item.asset;
        const secs = Number(a.duration) || 0;
        const dur = secs ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : '?';
        const fp = item.fiatProduct || {};
        const isFree = fp.isFree === true || fp.purchasePrice?.quantity?.significand === 0;
        const votes = item.voting || {};
        return {
          id: a.id,
          name: a.name,
          artist: (a.audioDetails && a.audioDetails.artist) || (item.creator && item.creator.name) || '-',
          duration: dur,
          isFree,
          likes: votes.voteCount ? `${Math.round(votes.upVotePercent || 0)}% 👍 (${votes.voteCount} vote)` : 'baru',
          storeUrl: `https://create.roblox.com/store/asset/${a.id}`
        };
      });

    res.json({ success: true, keyword, total: sdata.totalResults ?? results.length, results });
  } catch (error) {
    const msg = error?.name === 'TimeoutError' ? 'Roblox lambat merespons (timeout). Coba lagi.' : (error.message || 'Gagal mencari lagu');
    res.status(500).json({ success: false, error: msg });
  }
});

// ============================================================
// CEK INFO ASSET DARI ID (publik, tanpa API key) — AssetTypeId 3 = Audio
// ============================================================
app.get('/api/asset-info/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ success: false, error: 'ID harus berupa angka!' });
  }
  try {
    // Sumber 1: economy (paling lengkap: nama + tipe + kreator)
    const r = await fetch(`https://economy.roblox.com/v2/assets/${id}/details`, {
      headers: UA, signal: AbortSignal.timeout(15000)
    });
    if (r.ok) {
      const d = await r.json();
      return res.json({
        success: true,
        assetId: id,
        name: d.Name,
        assetTypeId: d.AssetTypeId,
        isAudio: d.AssetTypeId === 3,
        creator: d.Creator && (d.Creator.Name || d.Creator.Id),
        url: `rbxassetid://${id}`,
        storeUrl: `https://create.roblox.com/store/asset/${id}`
      });
    }
    if (r.status === 429) {
      return res.status(429).json({ success: false, error: 'Kena rate-limit Roblox, tunggu sebentar lalu coba lagi.' });
    }

    // Sumber 2 (fallback): toolbox items/details — bentuknya sudah pasti
    const t = await fetch(`https://apis.roblox.com/toolbox-service/v1/items/details?assetIds=${id}`, {
      headers: UA, signal: AbortSignal.timeout(15000)
    });
    const tj = await t.json().catch(() => ({}));
    const item = tj.data && tj.data[0];
    if (item && item.asset) {
      return res.json({
        success: true,
        assetId: id,
        name: item.asset.name,
        assetTypeId: item.asset.typeId,
        isAudio: item.asset.typeId === 3,
        creator: item.creator && item.creator.name,
        url: `rbxassetid://${id}`,
        storeUrl: `https://create.roblox.com/store/asset/${id}`
      });
    }

    const msg = r.status === 404
      ? 'Asset tidak ditemukan (ID salah, asset dihapus, atau privat).'
      : `Roblox API error (${r.status}).`;
    return res.status(r.status).json({ success: false, error: msg });
  } catch (error) {
    const msg = error?.name === 'TimeoutError' ? 'Roblox lambat merespons (timeout). Coba lagi.' : (error.message || 'Gagal mengambil info asset');
    res.status(500).json({ success: false, error: msg });
  }
});

// ============================================================
// GENERATE SCRIPT (untuk game KAMU sendiri) — mode: client | server | gui
// ============================================================
app.post('/api/generate-script', (req, res) => {
  try {
    const { musicId, volume = 1, loop = true, mode = 'client' } = req.body || {};
    if (musicId === undefined || musicId === null || String(musicId).trim() === '') {
      return res.status(400).json({ success: false, error: 'Music ID diperlukan!' });
    }
    if (!/^\d+$/.test(String(musicId).trim())) {
      return res.status(400).json({ success: false, error: 'Music ID harus berupa angka!' });
    }

    const v = Math.min(Math.max(Number(volume) || 1, 0), 10);
    const l = loop ? 'true' : 'false';
    const id = String(musicId).trim();
    const m = ['client', 'server', 'gui'].includes(mode) ? mode : 'client';

    let script;
    if (m === 'server') {
      script = `-- [SirLion] Musik server-side — taruh di ServerScriptService (game milikmu)\nlocal sound = Instance.new("Sound")\nsound.Name = "SirLionMusic"\nsound.SoundId = "rbxassetid://${id}"\nsound.Volume = ${v}\nsound.Looped = ${l}\nsound.Parent = workspace\nsound:Play()\nprint("[SirLion] Musik play: rbxassetid://${id}")`;
    } else if (m === 'gui') {
      script = `-- [SirLion] Tombol Play di layar — taruh di StarterGui (LocalScript)\nlocal Players = game:GetService("Players")\nlocal player = Players.LocalPlayer\n\nlocal screenGui = Instance.new("ScreenGui")\nscreenGui.Name = "SirLionMusicGui"\nscreenGui.ResetOnSpawn = false\nscreenGui.Parent = player:WaitForChild("PlayerGui")\n\nlocal btn = Instance.new("TextButton")\nbtn.Size = UDim2.new(0, 160, 0, 44)\nbtn.Position = UDim2.new(0, 12, 0.6, 0)\nbtn.Text = "🎵 Play Musik"\nbtn.Font = Enum.Font.GothamBold\nbtn.TextSize = 16\nbtn.TextColor3 = Color3.fromRGB(255, 255, 255)\nbtn.BackgroundColor3 = Color3.fromRGB(247, 151, 30)\nbtn.Parent = screenGui\n\nlocal playing = false\nlocal sound\n\nbtn.MouseButton1Click:Connect(function()\n\tif not sound then\n\t\tsound = Instance.new("Sound")\n\t\tsound.Name = "SirLionMusic"\n\t\tsound.SoundId = "rbxassetid://${id}"\n\t\tsound.Volume = ${v}\n\t\tsound.Looped = ${l}\n\t\tsound.Parent = workspace\n\tend\n\tplaying = not playing\n\tif playing then\n\t\tsound:Play()\n\t\tbtn.Text = "⏸ Stop Musik"\n\telse\n\t\tsound:Stop()\n\t\tbtn.Text = "🎵 Play Musik"\n\tend\nend)`;
    } else {
      script = `-- [SirLion] Musik client-side — taruh di StarterPlayer > StarterPlayerScripts (LocalScript)\nlocal sound = Instance.new("Sound")\nsound.Name = "SirLionMusic"\nsound.SoundId = "rbxassetid://${id}"\nsound.Volume = ${v}\nsound.Looped = ${l}\nsound.Parent = game:GetService("SoundService")\nsound:Play()\nprint("[SirLion] Musik play: rbxassetid://${id}")`;
    }

    res.json({ success: true, script, musicId: id, mode: m });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// 404 khusus API (selalu JSON) + ERROR HANDLER global
// ============================================================
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: `Endpoint ${req.path} tidak ditemukan.` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, error: 'File kebesaran! Maksimal 20 MB (aturan Roblox).' });
    }
    return res.status(400).json({ success: false, error: 'Upload error: ' + err.message });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'Request kebesaran.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'Body JSON tidak valid.' });
  }
  console.error('❌ Server error:', err);
  if (res.headersSent) return;
  res.status(500).json({ success: false, error: 'Server error: ' + (err?.message || 'unknown') });
});

// ============================================================
// START
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🦁 SirLion Uploader v2.1 running on port ${PORT}`);
});
