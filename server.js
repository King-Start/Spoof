const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ==========================================
// ROUTE: SPOOF AUDIO
// ==========================================
app.post('/api/spoof', async (req, res) => {
    try {
        console.log('📥 Spoof request:', req.body);
        const { assetId } = req.body;
        const apiKey = req.headers['x-api-key'] || process.env.ROBLOX_API_KEY;
        const userId = req.headers['x-user-id'] || process.env.ROBLOX_USER_ID;

        if (!apiKey || !userId) {
            return res.status(400).json({ success: false, error: 'API Key dan User ID diperlukan!' });
        }

        if (!assetId) {
            return res.status(400).json({ success: false, error: 'Asset ID diperlukan!' });
        }

        // ==========================================
        // DOWNLOAD AUDIO DARI ID ORANG LAIN
        // ==========================================
        console.log(`📥 Downloading audio ID: ${assetId}`);
        const audioUrl = `https://www.roblox.com/asset/?id=${assetId}`;
        const audioResponse = await axios.get(audioUrl, {
            responseType: 'arraybuffer',
            timeout: 30000
        });

        const audioBuffer = Buffer.from(audioResponse.data);
        const contentType = audioResponse.headers['content-type'] || 'audio/mpeg';
        const ext = contentType.includes('wav') ? 'wav' : contentType.includes('ogg') ? 'ogg' : 'mp3';
        const filename = `spoofed_${assetId}.${ext}`;
        console.log(`✅ Downloaded: ${filename} (${audioBuffer.length} bytes)`);

        // ==========================================
        // UPLOAD ULANG KE ROBLOX (PAKE API KEY LO)
        // ==========================================
        const form = new FormData();
        form.append('file', audioBuffer, { filename, contentType });

        const uploadRes = await axios.post(
            'https://apis.roblox.com/assets/v1/assets/upload',
            form,
            {
                headers: {
                    ...form.getHeaders(),
                    'x-api-key': apiKey,
                    'x-user-id': userId
                },
                timeout: 60000
            }
        );

        const newAssetId = uploadRes.data.assetId;
        console.log(`✅ New asset: ${newAssetId}`);

        res.json({
            success: true,
            originalAssetId: assetId,
            newAssetId: newAssetId,
            url: `rbxassetid://${newAssetId}`,
            message: `✅ Berhasil! ${assetId} → ${newAssetId}`
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message || 'Gagal spoof audio'
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
// ROUTE: CEK ASSET
// ==========================================
app.get('/api/asset/:id', async (req, res) => {
    try {
        const assetId = req.params.id;
        const apiKey = req.headers['x-api-key'] || process.env.ROBLOX_API_KEY;
        if (!apiKey) return res.status(400).json({ success: false, error: 'API Key diperlukan!' });

        const response = await axios.get(
            `https://apis.roblox.com/assets/v1/assets/${assetId}`,
            { headers: { 'x-api-key': apiKey }, timeout: 10000 }
        );
        res.json({ success: true, assetId, url: `rbxassetid://${assetId}`, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message || 'Asset tidak ditemukan' });
    }
});

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/api/health', (req, res) => {
    res.json({ status: '🔥 SirLion Running!', timestamp: new Date() });
});

// ==========================================
// START
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🔥 SirLion Spoof Music running on port ${PORT}`);
});
