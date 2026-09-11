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

// Animation repair is optional at startup so one missing deployment file cannot
// crash the entire Audio/Model studio. The animation endpoint returns a clear
// 503 until animation-tools.js and rbxm-parser are both available.
let patchAnimationRbxm = null;
let animationToolsError = null;
try {
  ({ patchAnimationRbxm } = require('./animation-tools'));
} catch (error) {
  animationToolsError = error;
  console.warn(`⚠️ Animation repair nonaktif: ${error.message}`);
}
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
// ============================================================
// FFMPEG DETECTION — dengan diagnosa & self-heal
// Prioritas: npm-bundled → system PATH → self-install binary resmi bila hosting membuang postinstall
// ============================================================
const BIN_INFO = {
  ffmpeg: { ok: false, path: null, error: 'belum dicek' }
};

function checkBin(p, verArgs) {
  if (/[/\\]/.test(p)) {
    if (!fs.existsSync(p)) return { ok: false, error: 'file tidak ada' };
    try { fs.chmodSync(p, 0o755); } catch {} // self-heal: permission sering hilang di hosting
    try { fs.accessSync(p, fs.constants.X_OK); }
    catch (e) { return { ok: false, error: 'tidak executable: ' + e.message }; }
  }
  try {
    const va = verArgs || ['--version'];
    const r = spawnSync(p, va, { timeout: 10000 });
    if (r && r.status === 0) return { ok: true };
    const msg = r && (r.stderr || r.stdout) ? (r.stderr || r.stdout).toString().slice(0, 150) : 'no output';
    return { ok: false, error: `${va.join(' ')} gagal (exit ${r && r.status}): ${msg}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

function detectBin(label, candidates, verArgs) {
  const errs = [];
  for (const c of candidates) {
    if (!c) continue;
    const r = checkBin(c, verArgs);
    if (r.ok) {
      BIN_INFO[label] = { ok: true, path: c, error: null };
      return c;
    }
    errs.push(`${c}: ${r.error}`);
  }
  BIN_INFO[label] = { ok: false, path: null, error: errs.join(' | ') || 'tidak ada kandidat' };
  return null;
}

let FFMPEG_BIN = null;
(function detectBins() {
  let staticFfmpeg = null;
  try { staticFfmpeg = require('ffmpeg-static'); } catch {}
  // ffmpeg (semua build incl. static) pakai single-dash -version; --version bisa exit 8
  FFMPEG_BIN = detectBin('ffmpeg', [staticFfmpeg, 'ffmpeg'], ['-version']);
  console.log(FFMPEG_BIN ? `🎬 ffmpeg OK: ${FFMPEG_BIN}` : `⚠️ ffmpeg TIDAK ADA (${BIN_INFO.ffmpeg.error})`);
})();

// Self-install ffmpeg-static resmi saat Railway/builder membuang binary postinstall.
// Release ini sama sumbernya dengan paket npm ffmpeg-static, hanya diunduh saat runtime.
let ffmpegInstallPromise = null;
async function ensureFfmpeg() {
  if (FFMPEG_BIN) return FFMPEG_BIN;
  if (!ffmpegInstallPromise) {
    ffmpegInstallPromise = (async () => {
      let staticFfmpeg = null;
      try { staticFfmpeg = require('ffmpeg-static'); } catch {}
      const found = detectBin('ffmpeg', [staticFfmpeg, 'ffmpeg'], ['-version']);
      if (found) { FFMPEG_BIN = found; return found; }

      const platform = process.platform;
      const archMap = { x64: 'x64', arm64: 'arm64', ia32: 'ia32', arm: 'arm' };
      const arch = archMap[process.arch];
      if (!['linux', 'darwin', 'win32'].includes(platform) || !arch) {
        throw new Error(`platform tidak didukung: ${platform}-${process.arch}`);
      }
      if (platform === 'win32' && arch !== 'x64') {
        throw new Error(`platform tidak didukung: ${platform}-${process.arch}`);
      }
      const asset = `ffmpeg-${platform}-${arch}.gz`;
      const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/${asset}`;
      const dest = path.join(os.tmpdir(), `sirlion-ffmpeg-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`);
      console.log(`📥 ffmpeg tidak ada — download binary static dari ${url} ...`);
      const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(240000) });
      if (!r.ok) throw new Error(`download ffmpeg gagal (HTTP ${r.status})`);
      const packed = Buffer.from(await r.arrayBuffer());
      if (packed.length < 10 * 1024 * 1024) throw new Error('arsip ffmpeg terlalu kecil (download rusak?)');
      let binary;
      try { binary = zlib.gunzipSync(packed); }
      catch (e) { throw new Error('gagal ekstrak ffmpeg: ' + e.message); }
      if (binary.length < 20 * 1024 * 1024) throw new Error('binary ffmpeg hasil ekstrak terlalu kecil');
      fs.writeFileSync(dest, binary);
      fs.chmodSync(dest, 0o755);
      const chk = checkBin(dest, ['-version']);
      if (!chk.ok) throw new Error('binary hasil download tidak jalan: ' + chk.error);
      FFMPEG_BIN = dest;
      BIN_INFO.ffmpeg = { ok: true, path: dest, error: null };
      console.log(`🎬 ffmpeg self-install OK: ${dest}`);
      return dest;
    })().catch((e) => {
      ffmpegInstallPromise = null;
      BIN_INFO.ffmpeg = { ok: false, path: null, error: 'self-install gagal: ' + e.message };
      throw e;
    });
  }
  return ffmpegInstallPromise;
}

// Mulai siapkan ffmpeg segera saat boot, tanpa menahan server/health endpoint.
if (!FFMPEG_BIN) ensureFfmpeg().catch((e) => console.error('❌ ffmpeg self-install:', e.message));

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

function failTag(name, r) {
  let extra = '';
  try {
    const j = JSON.parse(r.buf.subarray(0, 600).toString('utf8'));
    const e0 = j.errors && j.errors[0];
    if (e0) extra = ` → Roblox ${e0.code}: ${e0.message}`;
  } catch { /* bukan JSON */ }
  return `${name} (HTTP ${r.status}${extra})`;
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
      errors.push(failTag('v1', r));
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
      errors.push(failTag('v2-cdn', f));
    } else {
      const e0 = j.errors && j.errors[0];
      errors.push(e0 ? `v2 (HTTP ${r.status} → Roblox ${e0.code}: ${e0.message})` : `v2: tidak ada location (${r.status})`);
    }
  } catch (e) { errors.push(`v2: ${e.message}`); }

  // 2b) assetdelivery v1 varian path /v1/assetId/{id} (sekalian dicoba)
  try {
    const r = await fetchBytes(`https://assetdelivery.roblox.com/v1/assetId/${assetId}`);
    if (looksLikeAudio(r.buf, r.contentType)) {
      return { buffer: r.buf, source: 'assetdelivery-v1b' };
    }
    errors.push(failTag('v1b', r));
  } catch (e) { errors.push(`v1b: ${e.message}`); }

  // 3) Jalur BER-API-KEY ke assetdelivery (siapa tahu key-mu punya hak atas audio ini)
  if (apiKey) {
    try {
      const r = await fetch(`https://assetdelivery.roblox.com/v2/assetId/${assetId}`, {
        headers: { ...UA, 'x-api-key': apiKey }, signal: AbortSignal.timeout(20000)
      });
      const j = await r.json().catch(() => ({}));
      const loc = j.locations && j.locations[0] && j.locations[0].location;
      if (loc) {
        const f = await fetchBytes(loc);
        if (looksLikeAudio(f.buf, f.contentType)) {
          return { buffer: f.buf, source: 'assetdelivery-v2+key' };
        }
        errors.push(failTag('v2+key-cdn', f));
      } else {
        const e0 = j.errors && j.errors[0];
        errors.push(e0 ? `v2+key (HTTP ${r.status} → Roblox ${e0.code}: ${e0.message})` : `v2+key: tidak ada location (${r.status})`);
      }
    } catch (e) { errors.push(`v2+key: ${e.message}`); }
    try {
      const r = await fetchBytes(`https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`, { 'x-api-key': apiKey });
      if (looksLikeAudio(r.buf, r.contentType)) {
        return { buffer: r.buf, source: 'assetdelivery-v1+key' };
      }
      errors.push(failTag('v1+key', r));
    } catch (e) { errors.push(`v1+key: ${e.message}`); }
  }

  // 4) Open Cloud asset-delivery-api — butuh API key (audio milikmu / yang diizinkan)
  if (apiKey) {
    try {
      const r = await fetchBytes(`https://apis.roblox.com/asset-delivery-api/v1/assetId/${assetId}`, { 'x-api-key': apiKey });
      if (looksLikeAudio(r.buf, r.contentType)) {
        return { buffer: r.buf, source: 'open-cloud' };
      }
      errors.push(failTag('open-cloud', r));
    } catch (e) { errors.push(`open-cloud: ${e.message}`); }
  }

  const authFail = errors.length > 0 && errors.every((e) => /403|401|not authorized|unauthorized/i.test(e));
  const err = new Error(
    authFail
      ? `Audio ID ${assetId} dikunci PRIVAT oleh pemiliknya — Roblox menolak semua jalur download (detail: ${errors.join(' · ')}).`
      : `Gagal mengambil audio ID ${assetId} (${errors.join(' · ') || 'tidak ada respons'}). ` +
        'Kemungkinan: ID bukan audio publik, audio privat, atau Roblox membatasi akses.'
  );
  if (authFail) err.code = 'PRIVATE_ASSET';
  throw err;
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
    version: '1.9.0',
    node: process.version,
    ffmpeg: FFMPEG_BIN ? true : false,
    animationRepair: {
      ok: typeof patchAnimationRbxm === 'function',
      error: animationToolsError ? animationToolsError.message : null
    },
    bins: BIN_INFO,
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
    res.status(500).json({ success: false, error: error.message || 'Gagal spoof audio', code: error.code || 'SPOOF_FAILED' });
  }
});

// Cari kandidat publik + skor sendiri (dipakai /api/search-audio & /api/spoof-smart)
async function toolboxSearch(keyword, want = 8) {
  const sr = await fetch(
    `https://apis.roblox.com/toolbox-service/v1/marketplace/3?keyword=${encodeURIComponent(keyword)}&limit=${Math.min(want * 3, 20)}&sortType=Relevance&audioTypes=Music`,
    { headers: UA, signal: AbortSignal.timeout(20000) }
  );
  if (!sr.ok) throw new Error(sr.status === 429 ? 'Kena rate-limit Roblox (429).' : `Roblox search error (${sr.status}).`);
  const sdata = await sr.json();
  const ids = (sdata.data || []).map((x) => x.id).filter(Boolean).slice(0, 20);
  if (!ids.length) return { total: 0, results: [] };
  const dr = await fetch(
    `https://apis.roblox.com/toolbox-service/v1/items/details?assetIds=${ids.join(',')}`,
    { headers: UA, signal: AbortSignal.timeout(20000) }
  );
  const ddata = await dr.json().catch(() => ({ data: [] }));
  const tokens = keyword.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  let results = (ddata.data || [])
    .filter((item) => item.asset && item.asset.typeId === 3)
    .map((item) => {
      const a = item.asset;
      const secs = Number(a.duration) || 0;
      const name = a.name || '';
      const artist = (a.audioDetails && a.audioDetails.artist) || (item.creator && item.creator.name) || '-';
      const nl = name.toLowerCase(), al = artist.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (nl.includes(t)) score += 2;
        if (al.includes(t)) score += 1;
      }
      return {
        id: a.id, name, artist, secs, score,
        duration: secs ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : '?',
        storeUrl: `https://create.roblox.com/store/asset/${a.id}`
      };
    });
  if (tokens.length && results.some((x) => x.score > 0)) {
    results = results.filter((x) => x.score > 0);
  }
  results.sort((p, q) => (q.score - p.score) || (q.secs - p.secs));
  return { total: sdata.totalResults ?? results.length, results: results.slice(0, want) };
}

// ============================================================
// SEARCH AUDIO PUBLIK — GET /api/search-audio?keyword=&limit=
// Dipakai panel penyelamat: cari salinan publik dari lagu yang privat
// ============================================================
app.get('/api/search-audio', async (req, res) => {
  const keyword = (req.query.keyword || '').trim();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 20);
  if (!keyword) return res.status(400).json({ success: false, error: 'Ketik judul lagu dulu!' });
  try {
    const { total, results } = await toolboxSearch(keyword, limit);
    res.json({
      success: true, keyword, total,
      results: results.map(({ secs, score, ...rest }) => rest)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error?.name === 'TimeoutError' ? 'Roblox timeout. Coba lagi.' : (error.message || 'Gagal mencari') });
  }
});

// ============================================================
// SPOOF PINTAR — GET /api/spoof-smart/:id
// ID privat → otomatis cari & pakai salinan publik yang BUNYI.
// Balikan: binary audio + header X-Resolved-*
// ============================================================
app.get('/api/spoof-smart/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) return res.status(400).json({ success: false, error: 'ID harus berupa angka!' });
  const apiKey = (req.query.key || req.headers['x-api-key'] || '').trim();

  // 1) Coba langsung dulu (siapa tahu publik / key-mu berhak)
  try {
    const dl = await spoofDownload(id, apiKey);
    const ext = sniffAudioExt(dl.buffer) || 'mp3';
    const meta = await fetchAssetMeta(id);
    res.setHeader('Content-Type', EXT_TO_MIME[ext]);
    res.setHeader('Content-Length', dl.buffer.length);
    res.setHeader('X-Resolved-From', id);
    res.setHeader('X-Resolved-To', id);
    res.setHeader('X-Resolved-Name', encodeURIComponent(meta.name));
    res.setHeader('X-Resolved-Artist', encodeURIComponent(meta.creator));
    res.setHeader('X-Resolved-Format', ext);
    res.setHeader('X-Resolved-Source', dl.source);
    return res.send(dl.buffer);
  } catch (e) { /* lanjut ke salinan publik */ }

  // 2) Kumpulkan kandidat salinan publik (judul + artis + kata kunci)
  const meta = await fetchAssetMeta(id);
  const titleKnown = meta.name && !meta.name.startsWith('Audio_');
  const artistKnown = meta.creator && meta.creator !== '-';
  if (!titleKnown && !artistKnown) {
    return res.status(404).json({
      success: false, code: 'NO_PUBLIC_COPY',
      error: `ID ${id} tidak dikenal / sudah dihapus dari Roblox. Periksa lagi ID-nya.`
    });
  }
  const queries = [];
  if (titleKnown) queries.push(meta.name);
  if (artistKnown) queries.push(meta.creator);
  if (titleKnown) {
    const words = meta.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 5);
    for (const w of words.slice(0, 2)) queries.push(w);
  }

  const seen = new Set([id]);
  let candidates = [];
  for (const q of queries.slice(0, 4)) {
    try {
      const { results } = await toolboxSearch(q, 8);
      for (const c of results) {
        if (!seen.has(String(c.id)) && c.score > 0) {
          seen.add(String(c.id));
          candidates.push(c);
        }
      }
    } catch { /* query gagal → lanjut */ }
  }
  // WAJIB cocok dengan JUDUL asli (artis sama tapi lagu beda → jangan auto-load)
  const titleToks = (meta.name || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  candidates = candidates.map((c) => {
    const nl = (c.name || '').toLowerCase(), al = (c.artist || '').toLowerCase();
    let s = 0;
    for (const t of titleToks) { if (nl.includes(t)) s += 2; if (al.includes(t)) s += 1; }
    return { ...c, score: s };
  }).filter((c) => titleToks.length > 0 && c.score > 0);
  candidates.sort((p, q) => (q.score - p.score) || (q.secs - p.secs));
  candidates = candidates.slice(0, 6);

  if (!candidates.length) {
    return res.status(404).json({
      success: false, code: 'NO_PUBLIC_COPY',
      error: `ID ${id} ("${meta.name}") privat dan tidak ditemukan salinan publiknya di Creator Store. Pakai jalur penyelamat: link MP3 langsung / upload file.`
    });
  }

  // 3) Coba kandidat satu per satu sampai ada yang BUNYI
  console.log(`🔍 smart-spoof ${id} ("${meta.name}"): ${candidates.length} salinan akan dicoba...`);
  const tried = [];
  for (const c of candidates) {
    try {
      const dl = await spoofDownload(String(c.id), apiKey);
      console.log(`✅ smart-spoof ${id} → salinan ${c.id} ("${c.name}") BUNYI via ${dl.source}`);
      const ext = sniffAudioExt(dl.buffer) || 'mp3';
      res.setHeader('Content-Type', EXT_TO_MIME[ext]);
      res.setHeader('Content-Length', dl.buffer.length);
      res.setHeader('X-Resolved-From', id);
      res.setHeader('X-Resolved-To', String(c.id));
      res.setHeader('X-Resolved-Name', encodeURIComponent(c.name));
      res.setHeader('X-Resolved-Artist', encodeURIComponent(c.artist));
      res.setHeader('X-Resolved-Format', ext);
      res.setHeader('X-Resolved-Source', dl.source);
      return res.send(dl.buffer);
    } catch (e) {
      tried.push(c.id);
    }
  }
  res.status(404).json({
    success: false, code: 'NO_PUBLIC_COPY',
    error: `ID ${id} privat; ${tried.length} salinan publik dicoba tapi semuanya juga terkunci. Pakai jalur penyelamat: link MP3 langsung / upload file.`
  });
});

// ============================================================
// MODEL RBXM/RBXMX — upload manual melalui Open Cloud
// ============================================================
app.post('/api/upload-model', uploadSmall.single('file'), async (req, res) => {
  const { apiKey, userId, groupId } = getCreds(req);
  if (!apiKey || !userId) return res.status(400).json({ success: false, error: 'API Key dan User ID wajib diisi dan disimpan dulu!' });
  if (!req.file) return res.status(400).json({ success: false, error: 'Pilih file .rbxm atau .rbxmx dulu!' });
  const ext = path.extname(req.file.originalname || '').toLowerCase();
  if (!['.rbxm', '.rbxmx'].includes(ext)) return res.status(400).json({ success: false, error: 'Model harus berformat .rbxm atau .rbxmx!' });
  if (!looksLikeRbxm(req.file.buffer)) return res.status(400).json({ success: false, error: 'Isi file bukan RBXM/RBXMX Roblox yang valid.' });
  try {
    const fallbackName = path.basename(req.file.originalname, ext).slice(0, 50) || 'SirLion Model';
    const name = String(req.body.name || fallbackName).trim().slice(0, 50) || fallbackName;
    const metadata = {
      assetType: 'Model', displayName: name,
      description: 'Model uploaded via SirLion Studio',
      creationContext: { creator: groupId ? { groupId: String(groupId) } : { userId: String(userId) } }
    };
    const form = new FormData();
    form.append('request', JSON.stringify(metadata));
    form.append('fileContent', new Blob([req.file.buffer], { type: 'model/x-rbxm' }), `model${ext}`);
    const r = await fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST', headers: { 'x-api-key': apiKey }, body: form, signal: AbortSignal.timeout(120000)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = r.status === 401 ? 'API Key tidak valid / kedaluwarsa (401).'
        : r.status === 403 ? `Roblox menolak (403): ${data.message || 'aktifkan Assets Read + Write dan cek IP allowlist.'}`
        : data.message || `Roblox API error (${r.status}).`;
      return res.status(r.status).json({ success: false, error: msg, details: data });
    }
    let op = data;
    if (!data.done && data.path && String(data.path).startsWith('operations/')) op = await pollOperation(apiKey, data.path);
    if (op.error) return res.status(500).json({ success: false, error: `Roblox menolak model: ${op.error.message || 'unknown'}`, details: op });
    const newAssetId = extractAssetId(op);
    if (!newAssetId) return res.status(500).json({ success: false, error: 'Upload terkirim tetapi ID model belum terbaca.', details: op });
    console.log(`📦 Model upload OK: ${newAssetId} ("${name}", ${(req.file.size / 1024 / 1024).toFixed(2)} MB)`);
    res.json({
      success: true, newAssetId, name, format: ext.slice(1).toUpperCase(), size: req.file.size,
      url: `rbxassetid://${newAssetId}`,
      storeUrl: `https://create.roblox.com/store/asset/${newAssetId}`
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message || 'Gagal upload model' });
  }
});

// ============================================================
// ANIMATION — cari animasi publik + reupload Open Cloud (.rbxm)
// ============================================================
function looksLikeRbxm(buf) {
  if (!buf || buf.length < 100) return false;
  const head = buf.subarray(0, 32).toString('utf8');
  return head.startsWith('<roblox!') || head.startsWith('<roblox') || head.startsWith('<?xml');
}

async function animationBytesFromResponse(r) {
  if (!r || !r.ok) return null;
  if (looksLikeRbxm(r.buf)) return r.buf;
  // Open Cloud Asset Delivery mengembalikan JSON berisi signed CDN location,
  // bukan selalu byte RBXM langsung.
  try {
    const j = JSON.parse(r.buf.toString('utf8'));
    const loc = j?.locations?.[0]?.location || j?.location || null;
    if (!loc) return null;
    const u = new URL(loc);
    if (!(u.hostname === 'rbxcdn.com' || u.hostname.endsWith('.rbxcdn.com'))) {
      throw new Error('lokasi asset bukan CDN Roblox');
    }
    const cdn = await fetchBytes(loc);
    return cdn.ok && looksLikeRbxm(cdn.buf) ? cdn.buf : null;
  } catch (e) {
    if (/bukan CDN Roblox/.test(e.message)) throw e;
    return null;
  }
}

async function downloadAnimation(assetId, apiKey = '') {
  const headers = apiKey ? { 'x-api-key': apiKey } : {};
  const attempts = [
    [`https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`, {}],
    [`https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`, headers],
    [`https://apis.roblox.com/asset-delivery-api/v1/assetId/${assetId}`, headers]
  ];
  const errors = [];
  for (const [url, h] of attempts) {
    if (url.includes('apis.roblox.com') && !apiKey) continue;
    try {
      const r = await fetchBytes(url, h);
      const buf = await animationBytesFromResponse(r);
      if (buf) {
        if (buf.length > 20 * 1024 * 1024) throw new Error('Animasi >20 MB.');
        return buf;
      }
      errors.push(r.ok ? 'HTTP 200 tanpa lokasi/RBXM' : `HTTP ${r.status}`);
    } catch (e) { errors.push(e.message); }
  }
  throw new Error(`Source RBXM ditolak Roblox (${errors.join(' · ') || 'akses ditolak'}). Pastikan key memiliki assets:read + asset:write dan legacy-assets:legacy-asset:manage serta key dibuat untuk pemilik animasi.`);
}

async function animationSourceAvailable(assetId, apiKey = '') {
  // Jalur publik tanpa autentikasi.
  try {
    const r = await fetch(`https://assetdelivery.roblox.com/v2/assetId/${assetId}`, {
      headers: UA, signal: AbortSignal.timeout(12000)
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.locations && j.locations[0] && j.locations[0].location) return true;
  } catch { /* lanjut Open Cloud */ }
  // Jalur Open Cloud memerlukan legacy-assets:legacy-asset:manage.
  if (apiKey) {
    try {
      const r = await fetchBytes(
        `https://apis.roblox.com/asset-delivery-api/v1/assetId/${assetId}`,
        { 'x-api-key': apiKey }
      );
      return Boolean(await animationBytesFromResponse(r));
    } catch { /* terkunci */ }
  }
  return false;
}

app.get('/api/search-animation', async (req, res) => {
  const keyword = String(req.query.keyword || '').trim();
  const apiKey = String(req.headers['x-api-key'] || '').trim();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 12);
  if (!keyword) return res.status(400).json({ success: false, error: 'Ketik nama animasi dulu!' });
  try {
    const sr = await fetch(`https://apis.roblox.com/toolbox-service/v1/marketplace/24?keyword=${encodeURIComponent(keyword)}&limit=${limit}&sortType=Relevance`, {
      headers: UA, signal: AbortSignal.timeout(20000)
    });
    if (!sr.ok) throw new Error(`Creator Store error (${sr.status})`);
    const sj = await sr.json();
    const ids = (sj.data || []).map((x) => String(x.id)).filter((x) => /^\d+$/.test(x)).slice(0, limit);
    // Economy mudah rate-limit bila dipanggil paralel; ambil metadata berurutan.
    const metas = [];
    for (const id of ids) {
      try {
        const r = await fetch(`https://economy.roblox.com/v2/assets/${id}/details`, { headers: UA, signal: AbortSignal.timeout(15000) });
        if (r.ok) {
          const d = await r.json();
          if (d.AssetTypeId === 24) metas.push({
            id, name: d.Name || `Animation_${id}`,
            creator: d.Creator?.Name || '-',
            publicDomain: Boolean(d.IsPublicDomain),
            downloadable: await animationSourceAvailable(id, apiKey),
            storeUrl: `https://create.roblox.com/store/asset/${id}`
          });
        }
      } catch { /* satu metadata gagal → lanjut hasil lain */ }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    res.json({ success: true, keyword, total: sj.totalResults || ids.length, results: metas });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.name === 'TimeoutError' ? 'Roblox timeout. Coba lagi.' : e.message });
  }
});

app.post('/api/reupload-animation/:id', async (req, res) => {
  const assetId = String(req.params.id || '').trim();
  if (!/^\d+$/.test(assetId)) return res.status(400).json({ success: false, error: 'ID animasi harus angka!' });
  const { apiKey, userId, groupId } = getCreds(req);
  if (!apiKey || !userId) return res.status(400).json({ success: false, error: 'API Key dan User ID wajib diisi dan disimpan dulu!' });
  try {
    const meta = await fetchAssetMeta(assetId);
    if (meta.assetTypeId !== 24) return res.status(400).json({ success: false, error: `ID ${assetId} bukan Animation (tipe ${meta.assetTypeId ?? 'tidak diketahui'}).` });
    const doUnlock = (req.body || {}).stripMaxPartTranslation !== false;
    if (doUnlock && typeof patchAnimationRbxm !== 'function') {
      return res.status(503).json({
        success: false,
        error: 'Repair animasi belum aktif di deployment, tetapi Audio/Model tetap berjalan. Upload animation-tools.js serta package.json/package-lock.json v1.5.2, lalu deploy commit terbaru.',
        details: animationToolsError ? animationToolsError.message : 'animation-tools tidak tersedia'
      });
    }
    const originalBuf = await downloadAnimation(assetId, apiKey);
    const patch = doUnlock ? patchAnimationRbxm(originalBuf) : { buffer: originalBuf, removed: 0, attributeBlobs: 0, rig: 'Unknown' };
    const buf = patch.buffer;
    const baseName = String((req.body || {}).name || meta.name || `Animation_${assetId}`).trim().slice(0, 40) || `Animation_${assetId}`;
    const name = (doUnlock ? `${baseName} Unlocked` : baseName).slice(0, 50);
    const metadata = {
      assetType: 'Animation', displayName: name,
      description: `Animation reuploaded from asset ${assetId}${doUnlock ? '; MaxPartTranslation stripped' : ''}`, 
      creationContext: { creator: groupId ? { groupId: String(groupId) } : { userId: String(userId) } }
    };
    const form = new FormData();
    form.append('request', JSON.stringify(metadata));
    form.append('fileContent', new Blob([buf], { type: 'model/x-rbxm' }), 'animation.rbxm');
    const r = await fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST', headers: { 'x-api-key': apiKey }, body: form, signal: AbortSignal.timeout(120000)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = r.status === 401 ? 'API Key tidak valid / kedaluwarsa (401).'
        : r.status === 403 ? `Roblox menolak (403): ${data.message || 'aktifkan Assets Read + Write dan cek IP allowlist.'}`
        : data.message || `Roblox API error (${r.status}).`;
      return res.status(r.status).json({ success: false, error: msg, details: data });
    }
    let op = data;
    if (!data.done && data.path && String(data.path).startsWith('operations/')) op = await pollOperation(apiKey, data.path);
    if (op.error) return res.status(500).json({ success: false, error: `Roblox menolak animasi: ${op.error.message || 'unknown'}`, details: op });
    const newAssetId = extractAssetId(op);
    if (!newAssetId) return res.status(500).json({ success: false, error: 'Upload terkirim tetapi ID baru belum terbaca.', details: op });
    console.log(`🕺 Animation ${assetId} → ${newAssetId} ("${name}", rig ${patch.rig}, removed ${patch.removed})`);
    res.json({
      success: true, sourceAssetId: assetId, newAssetId, name, size: buf.length,
      rig: patch.rig, removedMaxPartTranslation: patch.removed, attributeBlobs: patch.attributeBlobs,
      url: `rbxassetid://${newAssetId}`, storeUrl: `https://create.roblox.com/store/asset/${newAssetId}`
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message || 'Gagal reupload animasi' });
  }
});

// ============================================================
// IMPORT DARI LINK LANGSUNG — POST /api/import-url { url }
// Server fetch URL mp3/ogg/wav (browser tidak bisa karena CORS)
// ============================================================
function isBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  if (h === '::1' || h === '[::1]' || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

app.post('/api/import-url', async (req, res) => {
  try {
    const raw = String((req.body || {}).url || '').trim();
    if (!raw) return res.status(400).json({ success: false, error: 'Tempel link audio dulu!' });
    let u;
    try { u = new URL(raw); } catch { return res.status(400).json({ success: false, error: 'Link tidak valid!' }); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
      return res.status(400).json({ success: false, error: 'Link harus http(s) biasa!' });
    }
    if (isBlockedHost(u.hostname)) {
      return res.status(400).json({ success: false, error: 'Host ini diblokir (keamanan).' });
    }

    // Ikuti redirect manual (maks 5) agar tiap hop tervalidasi
    let current = u.toString(), buf = null, ct = '';
    for (let hop = 0; hop < 5; hop++) {
      const r = await fetch(current, { headers: UA, redirect: 'manual', signal: AbortSignal.timeout(30000) });
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        const loc = r.headers.get('location');
        if (!loc) return res.status(400).json({ success: false, error: 'Redirect rusak dari link itu.' });
        const next = new URL(loc, current);
        if (!['http:', 'https:'].includes(next.protocol) || isBlockedHost(next.hostname)) {
          return res.status(400).json({ success: false, error: 'Link redirect ke host yang diblokir.' });
        }
        current = next.toString();
        continue;
      }
      if (!r.ok) return res.status(400).json({ success: false, error: `Link mengembalikan HTTP ${r.status}. Pastikan link file audio langsung.` });
      ct = (r.headers.get('content-type') || '').toLowerCase();
      const len = parseInt(r.headers.get('content-length') || '0', 10);
      if (len > 25 * 1024 * 1024) return res.status(413).json({ success: false, error: 'File di link itu >25 MB.' });
      buf = maybeGunzip(Buffer.from(await r.arrayBuffer()));
      break;
    }
    if (!buf) return res.status(400).json({ success: false, error: 'Kebanyakan redirect (>5).' });
    if (buf.length > 25 * 1024 * 1024) return res.status(413).json({ success: false, error: 'File audio >25 MB.' });
    const ext = sniffAudioExt(buf);
    if (!ext) {
      return res.status(400).json({ success: false, error: 'Isi link bukan file audio (MP3/OGG/WAV/FLAC). Catatan: link YouTube/Spotify/TikTok BUKAN file audio langsung — pakai link file .mp3/.ogg langsung.' });
    }
    const fname = decodeURIComponent(u.pathname.split('/').pop() || 'audio').replace(/\.[^.]+$/, '').slice(0, 50) || 'Audio dari link';
    res.setHeader('Content-Type', EXT_TO_MIME[ext]);
    res.setHeader('Content-Length', buf.length);
    res.setHeader('X-Import-Name', encodeURIComponent(fname));
    res.setHeader('X-Import-Format', ext);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (error) {
    res.status(500).json({ success: false, error: error?.name === 'TimeoutError' ? 'Link lambat/timeout.' : ('Gagal ambil link: ' + (error.message || 'unknown')) });
  }
});

// ============================================================
// DIAGNOSA AKSES — POST /api/diagnose-access { assetId }
// Cek langkah demi langkah kenapa key user ditolak untuk suatu ID
// ============================================================
app.post('/api/diagnose-access', async (req, res) => {
  try {
    const assetId = String((req.body || {}).assetId || '').trim();
    const { apiKey } = getCreds(req);
    if (!/^\d+$/.test(assetId)) return res.status(400).json({ success: false, error: 'Asset ID tidak valid!' });
    if (!apiKey) {
      return res.status(400).json({
        success: false,
        error: 'Simpan API key dulu (buka 🔑 Kredensial → Simpan), baru diagnosa. Kalau link store bunyi di browser-mu, kemungkinan besar key-mu yang kurang izin — diagnosa akan membuktikannya.'
      });
    }
    const steps = [];
    const meta = await fetchAssetMeta(assetId);
    steps.push({ ok: true, msg: `🎵 "${meta.name}" · milik ${meta.creator} · ${meta.assetTypeId === 3 ? 'Audio ✅' : 'tipe ' + meta.assetTypeId}` });

    // 1) Key valid? Punya asset:read?
    let keyValid = false, canRead = false;
    try {
      const q = await fetch('https://apis.roblox.com/assets/v1/assets/1', {
        headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(15000)
      });
      if (q.status === 401) {
        steps.push({ ok: false, msg: '❌ API key TIDAK VALID (401). Cek key di Credentials + IP allowlist.' });
      } else if (q.ok) {
        keyValid = true; canRead = true;
        steps.push({ ok: true, msg: '✅ Key valid + punya izin asset:read.' });
      } else {
        keyValid = true;
        steps.push({ ok: false, msg: `⚠️ Key VALID tapi ditolak baca metadata (${q.status}) → scope asset:read kemungkinan BELUM aktif. Aktifkan di Creator Dashboard → Credentials → key-mu → Permissions → Assets → Read (+ Write), tunggu ±1 menit.` });
      }
    } catch (e) {
      steps.push({ ok: false, msg: '❌ Tidak bisa menghubungi Roblox: ' + e.message });
    }

    // 2) Coba download via Open Cloud + key
    if (keyValid) {
      try {
        const r = await fetchBytes(`https://apis.roblox.com/asset-delivery-api/v1/assetId/${assetId}`, { 'x-api-key': apiKey });
        if (looksLikeAudio(r.buf, r.contentType)) {
          steps.push({ ok: true, msg: `✅ Download Open Cloud BERHASIL (${(r.buf.length / 1024 / 1024).toFixed(2)} MB) — SPOOF ULANG sekarang, harusnya tembus!` });
        } else {
          steps.push({ ok: false, msg: '❌ Open Cloud menolak: ' + failTag('download', r) });
        }
      } catch (e) { steps.push({ ok: false, msg: '❌ Open Cloud error: ' + e.message }); }

      // 3) Coba assetdelivery + key
      try {
        const r = await fetchBytes(`https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`, { 'x-api-key': apiKey });
        if (looksLikeAudio(r.buf, r.contentType)) {
          steps.push({ ok: true, msg: '✅ assetdelivery + key BERHASIL — SPOOF ULANG sekarang!' });
        } else {
          steps.push({ ok: false, msg: '❌ assetdelivery + key menolak: ' + failTag('v1+key', r) });
        }
      } catch (e) { steps.push({ ok: false, msg: '❌ assetdelivery + key error: ' + e.message }); }
    }

    const dlOk = steps.some((s) => /BERHASIL/.test(s.msg));
    let verdict;
    if (dlOk) {
      verdict = { ok: true, msg: '🎉 Salah satu jalur TEMBUS dengan key-mu — klik SPOOF ULANG di bawah!' };
    } else if (!keyValid) {
      verdict = { ok: false, msg: 'Perbaiki API key / IP allowlist dulu, lalu diagnosa + spoof ulang.' };
    } else if (!canRead) {
      verdict = { ok: false, msg: 'Aktifkan scope asset:read (+ asset:write) pada key-mu, tunggu ±1 menit, lalu SPOOF ULANG. Ini penyebab #1 kasus "link store bisa, app gagal".' };
    } else {
      verdict = { ok: false, msg: `Key-mu sehat (valid + asset:read), tapi akun pemilik key memang TIDAK punya hak atas audio milik "${meta.creator}" ini. Pastikan: (1) key dibuat di akun yang SAMA dengan browser-mu, (2) kalau audio grup — akunmu anggota grup itu. Jika ya dan tetap gagal → pemilik harus membuka akses; sementara itu pakai jalur penyelamat di bawah.` };
    }
    res.json({ success: true, steps, verdict });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Gagal diagnosa' });
  }
});

// ============================================================
// CONVERT — POST /api/convert (multipart)
// field: file + speed (0.5-2) + pitch (-12..12 st) + volume (0-200) + format (mp3|ogg|wav)
// Efek: atempo (speed, tempo→pitch stabil) + rubberband (pitch independen) + volume
// ============================================================
app.post('/api/convert', uploadBig.single('file'), async (req, res) => {
  try {
    await ensureFfmpeg();
  } catch (e) {
    return res.status(501).json({
      success: false, needFfmpeg: true,
      error: 'Server gagal menyiapkan ffmpeg otomatis (' + e.message + '). Cek /api/health untuk detail.'
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
// Open Cloud Create Asset + polling creation Operation.
// Operation completion creates an ID; it does NOT guarantee moderation approval.
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
      message: `Upload selesai dan ID ${newAssetId} dibuat. Status moderasi harus dipantau terpisah.`
    });
  } catch (error) {
    console.error('❌ Upload error:', error.message);
    res.status(500).json({ success: false, error: error.message || 'Gagal upload' });
  }
});

// ============================================================
// LIVE MODERATION STATUS — GET /api/asset-status/:id
// Uses the authenticated Open Cloud asset metadata endpoint.
// ============================================================
app.get('/api/asset-status/:id', async (req, res) => {
  const assetId = String(req.params.id || '').trim();
  const apiKey = String(req.headers['x-api-key'] || '').trim();
  if (!/^\d+$/.test(assetId)) return res.status(400).json({ success: false, error: 'Asset ID harus angka.' });
  if (!apiKey) return res.status(400).json({ success: false, error: 'API Key utama diperlukan untuk mengecek moderasi.' });
  try {
    const r = await fetch(`https://apis.roblox.com/assets/v1/assets/${assetId}`, {
      headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(15000)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = r.status === 401 ? 'API Key tidak valid (401).'
        : r.status === 403 ? 'Key tidak boleh membaca asset ini (403). Pastikan asset:read aktif dan key milik creator yang benar.'
        : r.status === 404 ? 'Asset belum tersedia di metadata Roblox (404). Coba lagi sebentar.'
        : data.message || `Gagal membaca status (${r.status}).`;
      return res.status(r.status).json({ success: false, error: msg });
    }
    const raw = String(data?.moderationResult?.moderationState || 'MODERATION_STATE_UNSPECIFIED');
    const state = raw.replace(/^MODERATION_STATE_/, '').toUpperCase();
    const labels = {
      APPROVED: 'Approved', REVIEWING: 'Dalam moderasi', REJECTED: 'Ditolak moderator',
      UNSPECIFIED: 'Belum diketahui'
    };
    res.json({
      success: true, assetId, state,
      label: labels[state] || raw,
      terminal: state === 'APPROVED' || state === 'REJECTED',
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error?.name === 'TimeoutError' ? 'Roblox timeout saat cek moderasi.' : error.message });
  }
});

// ============================================================
// AUDIO COLLABORATOR — POST /api/grant-audio-collaborator
// Official Asset Permissions API; no Roblox session cookie is used.
// ============================================================
app.post('/api/grant-audio-collaborator', async (req, res) => {
  const apiKey = String(req.headers['x-api-key'] || '').trim();
  const assetId = String(req.body?.assetId || '').trim();
  const collaborator = String(req.body?.collaborator || '').trim().replace(/^@/, '');
  if (!apiKey) return res.status(400).json({ success: false, error: 'API Key Utama diperlukan.' });
  if (!/^\d+$/.test(assetId)) return res.status(400).json({ success: false, error: 'Asset ID audio harus angka.' });
  if (!collaborator) return res.status(400).json({ success: false, error: 'Masukkan User ID atau username kolaborator.' });

  try {
    let collaboratorId, collaboratorName;
    if (/^\d+$/.test(collaborator)) {
      const u = await fetch(`https://users.roblox.com/v1/users/${collaborator}`, { headers: UA, signal: AbortSignal.timeout(15000) });
      const uj = await u.json().catch(() => ({}));
      if (!u.ok || !uj.id) return res.status(404).json({ success: false, error: `User ID ${collaborator} tidak ditemukan.` });
      collaboratorId = String(uj.id); collaboratorName = uj.name || collaboratorId;
    } else {
      const u = await fetch('https://users.roblox.com/v1/usernames/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...UA },
        body: JSON.stringify({ usernames: [collaborator], excludeBannedUsers: false }),
        signal: AbortSignal.timeout(15000)
      });
      const uj = await u.json().catch(() => ({}));
      const found = uj.data && uj.data[0];
      if (!found) return res.status(404).json({ success: false, error: `Username "${collaborator}" tidak ditemukan.` });
      collaboratorId = String(found.id); collaboratorName = found.name || collaborator;
    }

    // Confirm the key can manage this asset and that it is Audio.
    const metaResponse = await fetch(`https://apis.roblox.com/assets/v1/assets/${assetId}`, {
      headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(15000)
    });
    const meta = await metaResponse.json().catch(() => ({}));
    if (!metaResponse.ok) {
      return res.status(metaResponse.status).json({ success: false, error: metaResponse.status === 403
        ? 'Key tidak dapat mengelola asset ini. Pastikan asset:read aktif dan asset dimiliki creator key.'
        : meta.message || `Gagal memeriksa asset (${metaResponse.status}).` });
    }
    const type = String(meta.assetType || '').toUpperCase();
    if (type && !type.includes('AUDIO')) return res.status(400).json({ success: false, error: `Asset ${assetId} bukan Audio (${meta.assetType}).` });

    const grant = await fetch('https://apis.roblox.com/asset-permissions-api/v1/assets/permissions', {
      method: 'PATCH',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify({
        subjectType: 'User', subjectId: collaboratorId, action: 'Use',
        requests: [{ assetId: Number(assetId) }]
      }),
      signal: AbortSignal.timeout(20000)
    });
    const data = await grant.json().catch(() => ({}));
    if (!grant.ok) {
      const msg = grant.status === 403
        ? 'Roblox menolak (403). Tambahkan asset-permissions:write pada API Key Utama, pastikan kamu pemilik asset, dan user tersebut adalah teman Roblox-mu.'
        : data?.error?.message || data.message || `Asset Permissions API gagal (${grant.status}).`;
      return res.status(grant.status).json({ success: false, error: msg, details: data });
    }
    const successes = (data.successAssetIds || []).map(String);
    const errors = data.errors || [];
    if (!successes.includes(assetId) || errors.length) {
      return res.status(400).json({ success: false, error: `Roblox tidak memberikan izin: ${errors[0]?.code || 'hasil tidak dikonfirmasi'}`, details: data });
    }
    res.json({ success: true, assetId, collaboratorId, collaboratorName, permission: 'Use' });
  } catch (error) {
    res.status(500).json({ success: false, error: error?.name === 'TimeoutError' ? 'Roblox timeout.' : error.message });
  }
});

// ============================================================
// BULK AUDIO COLLABORATOR — up to 100 assets per Roblox API call.
// The browser queues as many calls/subjects as requested.
// ============================================================
app.post('/api/grant-audio-collaborators-bulk', async (req, res) => {
  const apiKey = String(req.headers['x-api-key'] || '').trim();
  const collaboratorId = String(req.body?.collaboratorId || '').trim();
  const rawIds = Array.isArray(req.body?.assetIds) ? req.body.assetIds : [];
  const assetIds = [...new Set(rawIds.map(String).map(x => x.trim()).filter(Boolean))];
  if (!apiKey) return res.status(400).json({ success: false, error: 'API Key Utama diperlukan.' });
  if (!/^\d+$/.test(collaboratorId)) return res.status(400).json({ success: false, error: 'User ID tujuan harus angka.' });
  if (!assetIds.length) return res.status(400).json({ success: false, error: 'Minimal satu Asset ID diperlukan.' });
  if (assetIds.length > 100) return res.status(400).json({ success: false, error: 'Maksimal 100 Asset ID per permintaan internal.' });
  if (assetIds.some(id => !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    return res.status(400).json({ success: false, error: 'Semua Asset ID harus berupa angka valid.' });
  }
  try {
    const grant = await fetch('https://apis.roblox.com/asset-permissions-api/v1/assets/permissions', {
      method: 'PATCH',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify({
        subjectType: 'User', subjectId: collaboratorId, action: 'Use',
        requests: assetIds.map(assetId => ({ assetId: Number(assetId) }))
      }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await grant.json().catch(() => ({}));
    if (!grant.ok) {
      const message = grant.status === 403
        ? 'Roblox menolak (403): aktifkan asset-permissions:write, gunakan asset milik creator key, dan pastikan User tujuan sudah menjadi teman.'
        : grant.status === 429 ? 'Rate-limit Roblox (429). Tunggu sekitar satu menit lalu lanjutkan lagi.'
        : data?.error?.message || data.message || `Asset Permissions API gagal (${grant.status}).`;
      return res.status(grant.status).json({ success: false, error: message, details: data });
    }
    const successIds = (data.successAssetIds || []).map(String);
    const errors = (data.errors || []).map(error => ({ assetId: String(error.assetId || ''), code: String(error.code || 'UNKNOWN') }));
    res.json({ success: true, collaboratorId, granted: successIds.length, failed: errors.length, successAssetIds: successIds, errors });
  } catch (error) {
    res.status(500).json({ success: false, error: error?.name === 'TimeoutError' ? 'Roblox timeout saat memberikan izin.' : error.message });
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
    const mode = String(req.body.mode || 'general').trim();
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

    let legacyOk = true;
    if (mode === 'animation') {
      legacyOk = false;
      try {
        const test = await fetch('https://apis.roblox.com/asset-delivery-api/v1/assetId/656118852', {
          headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(20000)
        });
        if (test.ok) {
          legacyOk = true;
          report.push({ ok: true, msg: '✅ Asset Delivery animasi OK — legacy-asset:manage aktif.' });
        } else {
          const body = await test.text().catch(() => '');
          report.push({ ok: false, msg: `❌ Asset Delivery animasi ditolak (${test.status}). Pastikan legacy-assets: legacy-asset:manage aktif.${body ? ' ' + body.slice(0, 120) : ''}` });
        }
      } catch (e) {
        report.push({ ok: false, msg: `❌ Asset Delivery animasi gagal: ${e.message}` });
      }
    }

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

    res.json({ success: true, ok: Boolean(resolvedId && keyOk && legacyOk && groupOk), report });
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
  console.log(`🦁 SirLion Audio Studio v1.9.0 running on port ${PORT}`);
});
