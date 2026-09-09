const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const { spawn } = require('child_process');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ==========================================
// AMBIL INFO AUDIO DARI ID
// ==========================================
async function getAudioInfo(assetId) {
    try {
        // Pake endpoint Roblox buat dapetin info asset
        const url = `https://economy.roblox.com/v2/assets/${assetId}/details`;
        const response = await axios.get(url);
        const data = response.data;
        return {
            name: data.Name || `Audio_${assetId}`,
            description: data.Description || '',
            created: data.Created,
            updated: data.Updated,
            assetType: data.AssetTypeId,
            isPublic: data.IsPublic,
            price: data.PriceInRobux || 0
        };
    } catch (error) {
        console.warn('⚠️ Gagal ambil info asset, pake default');
        return {
            name: `Audio_${assetId}`,
            description: '',
            assetType: 3
        };
    }
}

// ==========================================
// ROUTE: SPOOF + PREVIEW + INFO
// ==========================================
app.post('/api/spoof', async (req, res) => {
    try {
        const { assetId } = req.body;
        const apiKey = req.headers['x-api-key'] || process.env.ROBLOX_API_KEY;
        const userId = req.headers['x-user-id'] || process.env.ROBLOX_USER_ID;

        if (!apiKey || !userId) {
            return res.status(400).json({ success: false, error: 'API Key dan User ID diperlukan!' });
        }

        if (!assetId) {
            return res.status(400).json({ success: false, error: 'Asset ID diperlukan!' });
        }

        console.log(`🔄 Processing asset ID: ${assetId}`);

        // ==========================================
        // STEP 1: AMBIL INFO AUDIO
        // ==========================================
        const info = await getAudioInfo(assetId);
        console.log(`📝 Audio Name: ${info.name}`);

        // ==========================================
        // STEP 2: DOWNLOAD AUDIO ASLI
        // ==========================================
        // 🎯 PAKE ENDPOINT YANG BENAR!
        const audioUrl = `https://assetdelivery.roblox.com/v1/asset?id=${assetId}`;
        console.log(`📥 Downloading from: ${audioUrl}`);

        const audioResponse = await axios.get(audioUrl, {
            responseType: 'arraybuffer',
            timeout: 60000,
            headers: {
                'User-Agent': 'Roblox/WinInet',
                'Accept': 'application/octet-stream'
            }
        });

        const audioBuffer = Buffer.from(audioResponse.data);
        const contentType = audioResponse.headers['content-type'] || 'audio/mpeg';
        const ext = contentType.includes('wav') ? 'wav' : 
                    contentType.includes('ogg') ? 'ogg' : 'mp3';
        const filename = `${info.name || 'spoofed'}_${assetId}.${ext}`;

        // Cek ukuran (kalo 4KB berarti error)
        if (audioBuffer.length < 10000) {
            throw new Error('Audio file terlalu kecil (kemungkinan placeholder)');
        }

        console.log(`✅ Audio downloaded: ${filename} (${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

        // ==========================================
        // STEP 3: KONVERSI KE BASE64 (BUAT PREVIEW)
        // ==========================================
        const audioBase64 = audioBuffer.toString('base64');
        const audioDataUrl = `data:${contentType};base64,${audioBase64}`;

        // ==========================================
        // STEP 4: KIRIM HASIL KE FRONTEND
        // ==========================================
        res.json({
            success: true,
            originalAssetId: assetId,
            filename: filename,
            name: info.name,
            description: info.description,
            size: audioBuffer.length,
            sizeFormatted: `${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB`,
            audioDataUrl: audioDataUrl,  // ⭐ BUAT PREVIEW!
            contentType: contentType,
            assetType: info.assetType,
            message: `✅ Audio "${info.name}" siap di-preview!`
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message || 'Gagal download audio'
        });
    }
});

// ==========================================
// ROUTE: UPLOAD KE ROBLOX
// ==========================================
app.post('/api/upload-to-roblox', async (req, res) => {
    try {
        const { audioDataUrl, filename, name, assetId } = req.body;
        const apiKey = req.headers['x-api-key'] || process.env.ROBLOX_API_KEY;
        const userId = req.headers['x-user-id'] || process.env.ROBLOX_USER_ID;

        if (!apiKey || !userId) {
            return res.status(400).json({ success: false, error: 'API Key dan User ID diperlukan!' });
        }

        if (!audioDataUrl) {
            return res.status(400).json({ success: false, error: 'Audio data diperlukan!' });
        }

        const base64Data = audioDataUrl.split(',')[1];
        const audioBuffer = Buffer.from(base64Data, 'base64');

        console.log(`📤 Uploading to Roblox: ${filename || 'audio.mp3'} (${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

        const form = new FormData();
        form.append('file', audioBuffer, {
            filename: filename || `${name || 'spoofed'}.mp3`,
            contentType: 'audio/mpeg'
        });

        const uploadRes = await axios.post(
            'https://apis.roblox.com/assets/v1/assets/upload',
            form,
            {
                headers: {
                    ...form.getHeaders(),
                    'x-api-key': apiKey,
                    'x-user-id': userId
                },
                timeout: 120000  // 2 menit timeout
            }
        );

        const newAssetId = uploadRes.data.assetId;
        console.log(`✅ New asset created: ${newAssetId}`);

        res.json({
            success: true,
            originalAssetId: assetId,
            newAssetId: newAssetId,
            url: `rbxassetid://${newAssetId}`,
            message: `✅ Berhasil upload! ID: ${newAssetId}`
        });

    } catch (error) {
        console.error('❌ Upload error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message || 'Gagal upload ke Roblox'
        });
    }
});

// ==========================================
// ROUTE: GENERATE SCRIPT
// ==========================================
app.post('/api/generate-script', (req, res) => {
    try {
        const { musicId, volume = 1, loop = true, useAC6 = false } = req.body;
        if (!musicId) {
            return res.status(400).json({ success: false, error: 'Music ID diperlukan!' });
        }

        let script;
        if (useAC6) {
            script = `-- AC6 Spoof
local function playServerMusic(musicId, v, p, l)
    v = v or ${volume}; p = p or 1; l = l or ${loop}
    local args = {[1]="newSound",[2]="SpoofedMusic",[3]=workspace,[4]="rbxassetid://"..musicId,[5]=p,[6]=v,[7]=l}
    game:GetService("ReplicatedStorage"):WaitForChild("AC6_FE_Sounds"):FireServer(unpack(args))
    game:GetService("ReplicatedStorage"):WaitForChild("AC6_FE_Sounds"):FireServer("playSound", "SpoofedMusic")
    print("✅ Musik ID: "..musicId)
end
playServerMusic("${musicId}")`;
        } else {
            script = `-- Simple Spoof
local s = Instance.new("Sound")
s.SoundId = "rbxassetid://${musicId}"
s.Volume = ${volume}
s.Looped = ${loop}
s.Parent = workspace
s:Play()
print("✅ Audio ID: ${musicId}")`;
        }

        res.json({ success: true, script, musicId, method: useAC6 ? 'AC6' : 'Simple' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// ROUTE: DOWNLOAD SCRIPT
// ==========================================
app.post('/api/download-script', (req, res) => {
    try {
        const { script, filename } = req.body;
        if (!script) return res.status(400).json({ success: false, error: 'Script diperlukan!' });
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${filename || 'spoof.lua'}"`);
        res.send(script);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/api/health', (req, res) => {
    res.json({ status: '🔥 SirLion Spoof Music Running!', timestamp: new Date() });
});

// ==========================================
// START
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🔥 SirLion Spoof Music running on port ${PORT}`);
});
