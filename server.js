// server.js — SirLion Uploader v2
// Upload audio MILIK SENDIRI ke Roblox via Open Cloud API (resmi, langsung aktif sebagai audio privat)
// Format request sesuai dokumentasi Roblox:
//   POST https://apis.roblox.com/assets/v1/assets
//   form-data: request (JSON metadata) + fileContent (binary audio)
//   header: x-api-key

const express = require('express');
const cors = require('cors');
const multer = require('multer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20 MB
});

// Format audio yang diterima Roblox (maks 7 menit durasi)
const ALLOWED_MIME = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac'
};

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static('public'));

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({ status: '🦁 SirLion Uploader running!', timestamp: new Date().toISOString() });
});

// ==========================================
// ROUTE: UPLOAD AUDIO SENDIRI → ROBLOX OPEN CLOUD
// ==========================================
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'] || process.env.ROBLOX_API_KEY;
    const userId = req.headers['x-user-id'] || process.env.ROBLOX_USER_ID;
    const groupId = req.headers['x-group-id'] || process.env.ROBLOX_GROUP_ID || null;

    if (!apiKey || !userId) {
      return res.status(400).json({
        success: false,
        error: 'API Key dan User ID wajib diisi! (isi di form, atau set ROBLOX_API_KEY & ROBLOX_USER_ID di .env)'
      });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Pilih file audio dulu!' });
    }

    const ext = ALLOWED_MIME[req.file.mimetype];
    if (!ext) {
      return res.status(400).json({
        success: false,
        error: `Format "${req.file.mimetype}" tidak didukung. Pakai MP3, OGG, WAV, atau FLAC (maks 7 menit).`
      });
    }

    const name = (req.body.name || req.file.originalname.replace(/\.[^.]+$/, '')).trim().slice(0, 50) || 'My Audio';

    console.log(`📤 Uploading "${name}" (${(req.file.size / 1024 / 1024).toFixed(2)} MB, ${ext})...`);

    // Metadata sesuai format Open Cloud — INI yang bikin kode lama kamu gagal
    const metadata = {
      assetType: 'Audio',
      displayName: name,
      description: 'Uploaded via SirLion Uploader',
      creationContext: {
        creator: groupId ? { groupId: String(groupId) } : { userId: String(userId) }
      }
    };

    const form = new FormData();
    form.append('request', JSON.stringify(metadata));
    form.append('fileContent', new Blob([req.file.buffer], { type: req.file.mimetype }), `audio.${ext}`);

    const r = await fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: form
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error('❌ Roblox API error:', r.status, data);
      return res.status(r.status).json({
        success: false,
        error: data.message || `Roblox API error (${r.status}). Cek API key & izin asset:write.`,
        details: data
      });
    }

    // Response bisa berupa { path: "assets/123" } / { assetId } / operation
    let newAssetId = data.assetId || null;
    if (!newAssetId && data.path) newAssetId = String(data.path).split('/').pop();
    if (!newAssetId && data.response && data.response.assetId) newAssetId = String(data.response.assetId);

    if (!newAssetId) {
      return res.status(500).json({
        success: false,
        error: 'Upload sukses tapi ID aset tidak terbaca dari response.',
        details: data
      });
    }

    console.log(`✅ Sukses! ID baru: ${newAssetId}`);

    res.json({
      success: true,
      newAssetId,
      name,
      size: `${(req.file.size / 1024 / 1024).toFixed(2)} MB`,
      format: ext.toUpperCase(),
      url: `rbxassetid://${newAssetId}`,
      message: `✅ Berhasil! Audio kamu live (privat) dengan ID baru: ${newAssetId}`
    });
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ success: false, error: error.message || 'Gagal upload audio' });
  }
});

// ==========================================
// ROUTE: CARI LAGU DI CREATOR STORE (publik, tanpa API key)
// keyword → daftar audio (nama, artis, durasi, ID)
// ==========================================
app.get('/api/search-audio', async (req, res) => {
  const keyword = (req.query.keyword || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 10, 20);
  if (!keyword) return res.status(400).json({ success: false, error: 'Ketik judul lagu dulu!' });

  try {
    const UA = { 'User-Agent': 'Mozilla/5.0' };
    const sr = await fetch(
      `https://apis.roblox.com/toolbox-service/v1/marketplace/3?keyword=${encodeURIComponent(keyword)}&limit=${limit}&sortType=Relevance&audioTypes=Music`,
      { headers: UA }
    );
    if (!sr.ok) {
      return res.status(sr.status).json({ success: false, error: `Roblox search error (${sr.status})` });
    }
    const sdata = await sr.json();
    const ids = (sdata.data || []).map(x => x.id);
    if (!ids.length) {
      return res.json({ success: true, keyword, results: [] });
    }

    const dr = await fetch(
      `https://apis.roblox.com/toolbox-service/v1/items/details?assetIds=${ids.join(',')}`,
      { headers: UA }
    );
    const ddata = await dr.json().catch(() => ({ data: [] }));

    const results = (ddata.data || []).map(item => {
      const a = item.asset || {};
      const dur = a.duration ? `${Math.floor(a.duration / 60)}:${String(a.duration % 60).padStart(2, '0')}` : '?';
      return {
        id: a.id,
        name: a.name,
        artist: (a.audioDetails && a.audioDetails.artist) || (item.creator && item.creator.name) || '-',
        duration: dur,
        isFree: item.fiatProduct && item.fiatProduct.purchasePrice
          ? (item.fiatProduct.purchasePrice.isFree === true || item.fiatProduct.purchasePrice.quantity?.significand === 0)
          : null,
        likes: item.voting ? `${Math.round((item.voting.upVotePercent || 0))}% 👍` : '-',
        storeUrl: `https://create.roblox.com/store/asset/${a.id}`
      };
    });

    res.json({ success: true, keyword, total: sdata.totalResults, results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Gagal mencari lagu' });
  }
});

// ==========================================
// ROUTE: CEK INFO ASSET DARI ID (publik, tanpa API key)
// AssetTypeId 3 = Audio
// ==========================================
app.get('/api/asset-info/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ success: false, error: 'ID harus berupa angka!' });
  }
  try {
    const r = await fetch(`https://economy.roblox.com/v2/assets/${id}/details`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!r.ok) {
      const msg = r.status === 404 ? 'Asset tidak ditemukan (ID salah atau asset dihapus).'
        : r.status === 429 ? 'Kena rate-limit Roblox, tunggu sebentar lalu coba lagi.'
        : `Roblox API error (${r.status})`;
      return res.status(r.status).json({ success: false, error: msg });
    }
    const d = await r.json();
    const isAudio = d.AssetTypeId === 3;
    res.json({
      success: true,
      assetId: id,
      name: d.Name,
      assetTypeId: d.AssetTypeId,
      isAudio,
      creator: d.Creator && (d.Creator.Name || d.Creator.Id),
      url: `rbxassetid://${id}`,
      storeUrl: `https://create.roblox.com/store/asset/${id}`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Gagal mengambil info asset' });
  }
});

// ==========================================
// ROUTE: GENERATE SCRIPT (untuk game KAMU sendiri)
// mode: client | server | gui
// ==========================================
app.post('/api/generate-script', (req, res) => {
  try {
    const { musicId, volume = 1, loop = true, mode = 'client' } = req.body;
    if (!musicId) return res.status(400).json({ success: false, error: 'Music ID diperlukan!' });
    if (!/^\d+$/.test(String(musicId))) {
      return res.status(400).json({ success: false, error: 'Music ID harus berupa angka!' });
    }

    const v = Number(volume) || 1;
    const l = loop ? 'true' : 'false';
    const id = String(musicId);

    let script;
    if (mode === 'server') {
      script = `-- [SirLion] Musik server-side — taruh di ServerScriptService (game milikmu)
local sound = Instance.new("Sound")
sound.Name = "SirLionMusic"
sound.SoundId = "rbxassetid://${id}"
sound.Volume = ${v}
sound.Looped = ${l}
sound.Parent = workspace
sound:Play()
print("[SirLion] Musik play: rbxassetid://${id}")`;
    } else if (mode === 'gui') {
      script = `-- [SirLion] Tombol Play di layar — taruh di StarterGui (LocalScript)
local Players = game:GetService("Players")
local player = Players.LocalPlayer

local screenGui = Instance.new("ScreenGui")
screenGui.Name = "SirLionMusicGui"
screenGui.ResetOnSpawn = false
screenGui.Parent = player:WaitForChild("PlayerGui")

local btn = Instance.new("TextButton")
btn.Size = UDim2.new(0, 160, 0, 44)
btn.Position = UDim2.new(0, 12, 0.6, 0)
btn.Text = "🎵 Play Musik"
btn.Font = Enum.Font.GothamBold
btn.TextSize = 16
btn.TextColor3 = Color3.fromRGB(255, 255, 255)
btn.BackgroundColor3 = Color3.fromRGB(247, 151, 30)
btn.Parent = screenGui

local playing = false
local sound

btn.MouseButton1Click:Connect(function()
	if not sound then
		sound = Instance.new("Sound")
		sound.Name = "SirLionMusic"
		sound.SoundId = "rbxassetid://${id}"
		sound.Volume = ${v}
		sound.Looped = ${l}
		sound.Parent = workspace
	end
	playing = not playing
	if playing then
		sound:Play()
		btn.Text = "⏸ Stop Musik"
	else
		sound:Stop()
		btn.Text = "🎵 Play Musik"
	end
end)`;
    } else {
      script = `-- [SirLion] Musik client-side — taruh di StarterPlayer > StarterPlayerScripts (LocalScript)
local sound = Instance.new("Sound")
sound.Name = "SirLionMusic"
sound.SoundId = "rbxassetid://${id}"
sound.Volume = ${v}
sound.Looped = ${l}
sound.Parent = game:GetService("SoundService")
sound:Play()
print("[SirLion] Musik play: rbxassetid://${id}")`;
    }

    res.json({ success: true, script, musicId: id, mode });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// START
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🦁 SirLion Uploader running on port ${PORT}`);
});
