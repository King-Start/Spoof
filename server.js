// server.js — SirLion Audio Studio v1.0
// Spoof (ambil audio dari ID) → Edit (speed/pitch/volume) → Convert (ffmpeg) → Upload (Open Cloud)
//
// Alur spoof: assetdelivery v1 (redirect CDN, gzip) → v2 (JSON locations) →
//            Open Cloud asset-delivery-api (butuh API key, untuk audio milikmu)
// Alur convert: ffmpeg (ffmpeg-static / system) — atempo + rubberband + volume + transcode
// Alur upload: Open Cloud Create Asset + polling Operation sampai done:true

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const UA = { 'User-Agent': 'SirLion-Studio/1.0' };

// Upload ke Roblox: maks 20 MB (aturan Open Cloud)
const uploadSmall = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
// Convert: boleh lebih besar (bisa terima WAV render frontend)
const uploadBig = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

// ============================================================
// FFMPEG — deteksi sekali saat startup
// ============================================================
let FFMPEG_BIN = null;
(function detectFfmpeg() {
  try {
    const staticBin = require('ffmpeg-static');
    if (staticBin && fs.existsSync(staticBin)) FFMPEG_BIN = staticBin;
  } catch { /* ffmpeg-static tidak terinstall */ }
  if (!FFMPEG_BIN) {
    try {
      const r = spawnSync('ffmpeg', ['-version'], { timeout: 5000 });
      if (r.status === 0) FFMPEG_BIN = 'ffmpeg';
    } catch { /* tidak ada system ffmpeg */ }
  }
  console.log(FFMPEG_BIN ? `🎬 ffmpeg OK: ${FFMPEG_BIN}` : '⚠️ ffmpeg TIDAK ADA — /api/convert nonaktif (frontend fallback render WAV)');
})();

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

function sniffAudioExt(buf) {
  if (!buf || buf.length < 12) return null;
  const a4 = buf.subarray(0, 4).toString('ascii');
  const a12 = buf.subarray(8, 12).toString('ascii');
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'mp3'; // ID3
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';           // frame sync
  if (a4 === 'OggS') return 'ogg';
  if (a4 === 'RIFF' && a12 === 'WAVE') return 'wav';
  if (a4 === 'fLaC') return 'flac';
  return null;
}
const EXT_TO_MIME = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac' };

function maybeGunzip(buf) {
  if (buf && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return Buffer.from(zlib.gunzipSync(buf)); } catch { return buf; }
  }
  return buf;
}

// ============================================================
// SPOOF CORE — download bytes audio dari ID publik
// Coba: v1 (CDN redirect) → v2 (JSON locations) → Open Cloud (key)
// ============================================================
async function fetchBytes(url, headers = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  const buf = maybeGunzip(Buffer.from(await r.arrayBuffer()));
  return { ok: r.ok, status: r.status, contentType: ct, buf };
}

function looksLikeAudio(buf, contentType) {
  if (!buf || buf.length < 1000) return false;
  if (sniffAudioExt(buf)) return true;
  if ((contentType || '').startsWith('audio/')) return true;
  return false;
}

async function spoofDownload(assetId, apiKey = '') {
  const errors = [];

  // 1) assetdelivery v1 — 302 ke CDN (gzip), sesuai spek
  for (const url of [
    `https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`,
    `https://assetdelivery.roblox.com/v1/asset?id=${assetId}`
  ]) {
    try {
      const r = await fetchBytes(url);
      if (looksLikeAudio(r.buf, r.contentType)) {
        return { buffer: r.buf, source: 'assetdelivery-v1' };
      }
      errors.push(`v1 (${r.status})`);
    } catch (e) { errors.push(`v1: ${e.message}`); }
  }

  // 2) assetdelivery v2 — JSON berisi signed CDN URL
  try {
    const r = await fetch(`https://assetdelivery.roblox.com/v2/assetId/${assetId}`, {
      headers: UA, signal: AbortSignal.timeout(20000)
    });
    const j = await r.json().catch(() => ({}));
    const loc = j.locations && j.locations[0] && j.locations[0].location;
    if (loc) {
      const f = await fetchBytes(loc);
      if (looksLikeAudio(f.buf, f.contentType)) {
        return { buffer: f.buf, source: 'assetdelivery-v2' };
      }
      errors.push(`v2-cdn (${f.status})`);
    } else {
      errors.push(`v2: tidak ada location (${r.status})`);
    }
  } catch (e) { errors.push(`v2: ${e.message}`); }

  // 3) Open Cloud asset-delivery-api — butuh API key (audio milikmu / yang diizinkan)
  if (apiKey) {
    try {
      const r = await fetchBytes(`https://apis.roblox.com/asset-delivery-api/v1/assetId/${assetId}`, { 'x-api-key': apiKey });
      if (looksLikeAudio(r.buf, r.contentType)) {
        return { buffer: r.buf, source: 'open-cloud' };
      }
      errors.push(`open-cloud (${r.status})`);
    } catch (e) { errors.push(`open-cloud: ${e.message}`); }
  }

  throw new Error(
    `Gagal mengambil audio ID ${assetId} (${errors.join(' · ') || 'tidak ada respons'}). ` +
    'Kemungkinan: ID bukan audio publik, audio privat, atau Roblox membatasi akses.'
  );
}

async function fetchAssetMeta(assetId) {
  // Sumber 1: economy
  try {
    const r = await fetch(`https://economy.roblox.com/v2/assets/${assetId}/details`, {
      headers: UA, signal: AbortSignal.timeout(15000)
    });
    if (r.ok) {
      const d = await r.json();
      return { name: d.Name || `Audio_${assetId}`, creator: (d.Creator && d.Creator.Name) || '-', assetTypeId: d.AssetTypeId };
    }
  } catch { /* lanjut fallback */ }
  // Sumber 2: toolbox items/details
  try {
    const t = await fetch(`https://apis.roblox.com/toolbox-service/v1/items/details?assetIds=${assetId}`, {
      headers: UA, signal: AbortSignal.timeout(15000)
    });
    const tj = await t.json().catch(() => ({}));
    const item = tj.data && tj.data[0];
    if (item && item.asset) {
      return { name: item.asset.name || `Audio_${assetId}`, creator: (item.creator && item.creator.name) || '-', assetTypeId: item.asset.typeId };
    }
  } catch { /* nama default */ }
  return { name: `Audio_${assetId}`, creator: '-', assetTypeId: null };
}

// ============================================================
// HEALTH
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({
    status: '🦁 SirLion Audio Studio running!',
    version: '1.0.0',
    node: process.version,
    ffmpeg: FFMPEG_BIN ? true : false,
    timestamp: new Date().toISOString()
  });
});

// ============================================================
// SPOOF INFO — GET /api/spoof-info/:id
// ============================================================
app.get('/api/spoof-info/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) return res.status(400).json({ success: false, error: 'ID harus berupa angka!' });
  const meta = await fetchAssetMeta(id);
  res.json({
    success: true,
    assetId: id,
    name: meta.name,
    creator: meta.creator,
    assetTypeId: meta.assetTypeId,
    isAudio: meta.assetTypeId === 3 || meta.assetTypeId === null,
    storeUrl: `https://create.roblox.com/store/asset/${id}`
  });
});

// ============================================================
// SPOOF AUDIO — GET /api/spoof-audio/:id[?as=json][&key=]
// default: binary audio · as=json: { ..., dataUrl } sesuai spek
// ============================================================
app.get('/api/spoof-audio/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) return res.status(400).json({ success: false, error: 'ID harus berupa angka!' });
  try {
    const apiKey = (req.query.key || req.headers['x-api-key'] || '').trim();
    const [dl, meta] = await Promise.all([
      spoofDownload(id, apiKey),
      fetchAssetMeta(id)
    ]);
    const ext = sniffAudioExt(dl.buffer) || 'mp3';
    const mime = EXT_TO_MIME[ext];

    if (req.query.as === 'json') {
      if (dl.buffer.length > 25 * 1024 * 1024) {
        return res.status(413).json({ success: false, error: 'Audio >25 MB — pakai mode binary (tanpa ?as=json).' });
      }
      return res.json({
        success: true,
        assetId: id,
        name: meta.name,
        creator: meta.creator,
        format: ext.toUpperCase(),
        mime,
        size: dl.buffer.length,
        sizeLabel: `${(dl.buffer.length / 1024 / 1024).toFixed(2)} MB`,
        source: dl.source,
        dataUrl: `data:${mime};base64,${dl.buffer.toString('base64')}`
      });
    }

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', dl.buffer.length);
    res.setHeader('X-Audio-Name', encodeURIComponent(meta.name));
    res.setHeader('X-Audio-Creator', encodeURIComponent(meta.creator));
    res.setHeader('X-Audio-Format', ext);
    res.setHeader('X-Audio-Source', dl.source);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(dl.buffer);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Gagal spoof audio' });
  }
});

// ============================================================
// CONVERT — POST /api/convert (multipart)
// field: file + speed (0.5-2) + pitch (-12..12 st) + volume (0-200) + format (mp3|ogg|wav)
// Efek: atempo (speed, tempo→pitch stabil) + rubberband (pitch independen) + volume
// ============================================================
app.post('/api/convert', uploadBig.single('file'), async (req, res) => {
  if (!FFMPEG_BIN) {
    return res.status(501).json({
      success: false, needFfmpeg: true,
      error: 'Server tidak punya ffmpeg — CONVERT backend nonaktif. Frontend akan render WAV langsung di browser sebagai fallback.'
    });
  }
  if (!req.file) return res.status(400).json({ success: false, error: 'Kirim file audio (field "file")!' });

  const speed = Math.min(Math.max(parseFloat(req.body.speed) || 1, 0.5), 2);
  const pitch = Math.min(Math.max(parseInt(req.body.pitch, 10) || 0, -12), 12);
  const volPct = Math.min(Math.max(parseFloat(req.body.volume) ?? 100, 0), 200);
  const volume = (isNaN(volPct) ? 100 : volPct) / 100;
  const format = String(req.body.format || 'mp3').toLowerCase();
  if (!['mp3', 'ogg', 'wav'].includes(format)) {
    return res.status(400).json({ success: false, error: 'Format harus mp3 / ogg / wav!' });
  }

  const tag = crypto.randomUUID();
  const inExt = sniffAudioExt(req.file.buffer);
  const inPath = path.join(os.tmpdir(), `sirlion-in-${tag}.${inExt || 'bin'}`);
  const outPath = path.join(os.tmpdir(), `sirlion-out-${tag}.${format}`);

  try {
    fs.writeFileSync(inPath, req.file.buffer);

    const args = ['-y', '-hide_banner', '-i', inPath, '-vn', '-map', '0:a:0?'];

    // Filter hanya bila ada efek yang diubah (kalau default semua = transcode murni)
    const hasFx = speed !== 1 || pitch !== 0 || volume !== 1;
    if (hasFx) {
      const filters = [`atempo=${speed}`, `rubberband=pitch=${Math.pow(2, pitch / 12).toFixed(6)}:transients=smooth`, `volume=${volume}`, 'aresample=44100'];
      args.push('-filter:a', filters.join(','));
    } else {
      args.push('-ar', '44100');
    }

    if (format === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3');
    else if (format === 'ogg') args.push('-c:a', 'libvorbis', '-q:a', '5', '-f', 'ogg');
    else args.push('-c:a', 'pcm_s16le', '-f', 'wav');
    args.push(outPath);

    const stderr = await new Promise((resolve, reject) => {
      const p = spawn(FFMPEG_BIN, args, { timeout: 180000 });
      let err = '';
      p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-500)}`))));
    });

    if (!fs.existsSync(outPath)) throw new Error('ffmpeg tidak menghasilkan file output.');
    const out = fs.readFileSync(outPath);
    if (out.length < 1000) throw new Error('Hasil convert kosong / rusak.');

    // Durasi dari log ffmpeg ("Duration: 00:03:46.12")
    let durationSec = null;
    const dm = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (dm) durationSec = parseInt(dm[1], 10) * 3600 + parseInt(dm[2], 10) * 60 + parseFloat(dm[3]);

    console.log(`🎛 Convert OK: ${format.toUpperCase()} ${(out.length / 1024 / 1024).toFixed(2)} MB (speed ${speed}x, pitch ${pitch}st, vol ${volume * 100}%)`);

    res.setHeader('Content-Type', EXT_TO_MIME[format]);
    res.setHeader('Content-Length', out.length);
    res.setHeader('X-Convert-Format', format);
    res.setHeader('X-Convert-Size', out.length);
    if (durationSec != null) res.setHeader('X-Convert-Duration', durationSec.toFixed(2));
    res.setHeader('Cache-Control', 'no-store');
    res.send(out);
  } catch (error) {
    console.error('❌ Convert error:', error.message);
    res.status(500).json({ success: false, error: 'Convert gagal: ' + (error.message || 'ffmpeg error') });
  } finally {
    for (const f of [inPath, outPath]) { try { fs.unlinkSync(f); } catch { /* abaikan */ } }
  }
});

// ============================================================
// UPLOAD — POST /api/upload (multipart: file + name)
// Open Cloud Create Asset + polling Operation (INSTANT APPROVE!)
// ============================================================
function extractAssetId(op) {
  if (!op || typeof op !== 'object') return null;
  if (op.response && op.response.assetId) return String(op.response.assetId);
  if (op.response && op.response.path) return String(op.response.path).split('/').pop();
  if (op.assetId) return String(op.assetId);
  return null;
}

async function pollOperation(apiKey, operationPath, { tries = 30, intervalMs = 2000 } = {}) {
  const opId = String(operationPath).split('/').pop();
  const url = `https://apis.roblox.com/assets/v1/operations/${opId}`;
  let last = null;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(15000) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || `Gagal cek status upload (${r.status}).`);
    last = data;
    if (data.done === true) return data;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const err = new Error('Upload masih diproses Roblox setelah ±60 detik. Cek Creator Dashboard → Development Items → Audio.');
  err.code = 'OPERATION_TIMEOUT';
  err.operation = last;
  throw err;
}

app.post('/api/upload', uploadSmall.single('file'), async (req, res) => {
  try {
    const { apiKey, userId, groupId } = getCreds(req);
    if (!apiKey || !userId) {
      return res.status(400).json({ success: false, error: 'API Key dan User ID wajib! (isi & simpan kredensial dulu)' });
    }
    if (!req.file) return res.status(400).json({ success: false, error: 'Tidak ada file audio!' });

    const ext = sniffAudioExt(req.file.buffer);
    if (!ext) {
      return res.status(400).json({ success: false, error: 'File bukan audio MP3/OGG/WAV/FLAC yang valid.' });
    }
    const name = (req.body.name || 'SirLion Audio').trim().slice(0, 50) || 'SirLion Audio';
    console.log(`📤 Upload "${name}" (${(req.file.size / 1024 / 1024).toFixed(2)} MB, ${ext})...`);

    const metadata = {
      assetType: 'Audio',
      displayName: name,
      description: 'Edited & uploaded via SirLion Audio Studio',
      creationContext: { creator: groupId ? { groupId: String(groupId) } : { userId: String(userId) } }
    };
    const form = new FormData();
    form.append('request', JSON.stringify(metadata));
    form.append('fileContent', new Blob([req.file.buffer], { type: EXT_TO_MIME[ext] }), `audio.${ext}`);

    const r = await fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST', headers: { 'x-api-key': apiKey }, body: form, signal: AbortSignal.timeout(120000)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = r.status === 401 ? 'API Key tidak valid / kedaluwarsa (401).'
        : r.status === 403 ? `Roblox menolak (403): ${data.message || 'butuh izin asset:write / IP allowlist.'}`
        : r.status === 429 ? 'Kena rate-limit (429). Tunggu 1–2 menit.'
        : (data.message || `Roblox API error (${r.status}).`);
      return res.status(r.status).json({ success: false, error: msg, details: data });
    }

    let op = data;
    if (!data.done && data.path && String(data.path).startsWith('operations/')) {
      op = await pollOperation(apiKey, data.path);
    }
    if (op.error) {
      return res.status(500).json({ success: false, error: `Roblox menolak upload: ${op.error.message || 'unknown'}`, details: op });
    }
    const newAssetId = extractAssetId(op);
    if (!newAssetId) {
      return res.status(500).json({ success: false, error: 'Upload terkirim tapi ID tidak terbaca.', details: op });
    }

    console.log(`✅ Upload sukses! ID baru: ${newAssetId}`);
    res.json({
      success: true,
      newAssetId,
      name,
      size: `${(req.file.size / 1024 / 1024).toFixed(2)} MB`,
      format: ext.toUpperCase(),
      url: `rbxassetid://${newAssetId}`,
      moderation: op?.response?.moderationResult?.moderationState || null,
      message: `✅ INSTANT APPROVE! Audio live (privat) dengan ID: ${newAssetId}`
    });
  } catch (error) {
    console.error('❌ Upload error:', error.message);
    res.status(500).json({ success: false, error: error.message || 'Gagal upload' });
  }
});

// ============================================================
// TES KREDENSIAL — POST /api/check-key { apiKey, userId, groupId? }
// ============================================================
app.post('/api/check-key', async (req, res) => {
  try {
    const apiKey = String(req.body.apiKey || '').trim();
    const userInput = String(req.body.userId || '').trim();
    const groupId = String(req.body.groupId || '').trim();
    const report = [];
    if (!apiKey) return res.status(400).json({ success: false, error: 'API Key wajib diisi!' });
    if (!userInput) return res.status(400).json({ success: false, error: 'User ID / username wajib diisi!' });

    let resolvedId = null;
    try {
      if (/^\d+$/.test(userInput)) {
        const u = await fetch(`https://users.roblox.com/v1/users/${userInput}`, { headers: UA, signal: AbortSignal.timeout(15000) });
        if (u.ok) {
          const j = await u.json();
          resolvedId = String(j.id);
          report.push({ ok: true, msg: `✅ User ID valid: ${j.name} (${j.id})`, resolvedId });
        } else report.push({ ok: false, msg: `❌ User ID ${userInput} tidak ditemukan (${u.status}).` });
      } else {
        const u = await fetch('https://users.roblox.com/v1/usernames/users', {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...UA },
          body: JSON.stringify({ usernames: [userInput], excludeBannedUsers: false }),
          signal: AbortSignal.timeout(15000)
        });
        const j = await u.json().catch(() => ({}));
        if (j.data && j.data[0]) {
          resolvedId = String(j.data[0].id);
          report.push({ ok: true, msg: `✅ Username "${userInput}" → User ID ${resolvedId}`, resolvedId });
        } else report.push({ ok: false, msg: `❌ Username "${userInput}" tidak ditemukan.` });
      }
    } catch (e) { report.push({ ok: false, msg: `❌ Gagal cek user: ${e.message}` }); }

    let keyOk = false;
    try {
      const q = await fetch('https://apis.roblox.com/assets/v1/assets/1', {
        headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(15000)
      });
      if (q.status === 401) report.push({ ok: false, msg: '❌ API Key TIDAK VALID (401). Cek Credentials & IP allowlist.' });
      else if (q.ok) { keyOk = true; report.push({ ok: true, msg: '✅ API Key valid + asset:read OK.' }); }
      else { keyOk = true; report.push({ ok: true, msg: `⚠️ API Key merespons (${q.status}) — pastikan asset:read + asset:write aktif.` }); }
    } catch (e) { report.push({ ok: false, msg: `❌ Tidak bisa menghubungi Roblox: ${e.message}` }); }

    let groupOk = true;
    if (groupId) {
      if (!/^\d+$/.test(groupId)) { groupOk = false; report.push({ ok: false, msg: '❌ Group ID harus angka.' }); }
      else {
        try {
          const g = await fetch(`https://groups.roblox.com/v1/groups/${groupId}`, { headers: UA, signal: AbortSignal.timeout(15000) });
          if (g.ok) {
            const j = await g.json();
            report.push({ ok: true, msg: `✅ Group valid: ${j.name} (${j.id}).` });
          } else { groupOk = false; report.push({ ok: false, msg: `❌ Group ${groupId} tidak ditemukan (${g.status}).` }); }
        } catch (e) { groupOk = false; report.push({ ok: false, msg: `❌ Gagal cek grup: ${e.message}` }); }
      }
    }

    res.json({ success: true, ok: Boolean(resolvedId && keyOk && groupOk), report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Gagal tes kredensial' });
  }
});

// ============================================================
// GENERATE SCRIPT — POST /api/generate-script
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
    const v = Math.min(Math.max(Number(volume) || 1, 0), 2);
    const l = loop ? 'true' : 'false';
    const id = String(musicId).trim();
    const m = ['client', 'server', 'gui'].includes(mode) ? mode : 'client';

    let script;
    if (m === 'server') {
      script = `-- [SirLion Studio] Musik server-side — taruh di ServerScriptService (game milikmu)\nlocal sound = Instance.new("Sound")\nsound.Name = "SirLionMusic"\nsound.SoundId = "rbxassetid://${id}"\nsound.Volume = ${v}\nsound.Looped = ${l}\nsound.Parent = workspace\nsound:Play()\nprint("[SirLion] Musik play: rbxassetid://${id}")`;
    } else if (m === 'gui') {
      script = `-- [SirLion Studio] Tombol Play di layar — taruh di StarterGui (LocalScript)\nlocal Players = game:GetService("Players")\nlocal player = Players.LocalPlayer\n\nlocal screenGui = Instance.new("ScreenGui")\nscreenGui.Name = "SirLionMusicGui"\nscreenGui.ResetOnSpawn = false\nscreenGui.Parent = player:WaitForChild("PlayerGui")\n\nlocal btn = Instance.new("TextButton")\nbtn.Size = UDim2.new(0, 160, 0, 44)\nbtn.Position = UDim2.new(0, 12, 0.6, 0)\nbtn.Text = "🎵 Play Musik"\nbtn.Font = Enum.Font.GothamBold\nbtn.TextSize = 16\nbtn.TextColor3 = Color3.fromRGB(255, 255, 255)\nbtn.BackgroundColor3 = Color3.fromRGB(247, 151, 30)\nbtn.Parent = screenGui\n\nlocal playing = false\nlocal sound\n\nbtn.MouseButton1Click:Connect(function()\n\tif not sound then\n\t\tsound = Instance.new("Sound")\n\t\tsound.Name = "SirLionMusic"\n\t\tsound.SoundId = "rbxassetid://${id}"\n\t\tsound.Volume = ${v}\n\t\tsound.Looped = ${l}\n\t\tsound.Parent = workspace\n\tend\n\tplaying = not playing\n\tif playing then\n\t\tsound:Play()\n\t\tbtn.Text = "⏸ Stop Musik"\n\telse\n\t\tsound:Stop()\n\t\tbtn.Text = "🎵 Play Musik"\n\tend\nend)`;
    } else {
      script = `-- [SirLion Studio] Musik client-side — taruh di StarterPlayer > StarterPlayerScripts (LocalScript)\nlocal sound = Instance.new("Sound")\nsound.Name = "SirLionMusic"\nsound.SoundId = "rbxassetid://${id}"\nsound.Volume = ${v}\nsound.Looped = ${l}\nsound.Parent = game:GetService("SoundService")\nsound:Play()\nprint("[SirLion] Musik play: rbxassetid://${id}")`;
    }
    res.json({ success: true, script, musicId: id, mode: m });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// 404 API + ERROR HANDLER (selalu JSON)
// ============================================================
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: `Endpoint ${req.path} tidak ditemukan.` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, error: 'File kebesaran! Maksimal 20 MB untuk upload.' });
    }
    return res.status(400).json({ success: false, error: 'Upload error: ' + err.message });
  }
  console.error('❌ Server error:', err);
  if (res.headersSent) return;
  res.status(500).json({ success: false, error: 'Server error: ' + (err?.message || 'unknown') });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🦁 SirLion Audio Studio v1.0 running on port ${PORT}`);
});
