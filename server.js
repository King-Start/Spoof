// ==========================================
// SIRLION SPOOF MUSIC - FIXED FOR RAILWAY
// ==========================================

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(cors());
app.use(express.json());
app.use(express.static('public'));  // ⬅️ INI BUAT NAMPILIN WEB!

// ==========================================
// UPLOAD CONFIG - PAKE MEMORY STORAGE!
// ==========================================
const upload = multer({
    storage: multer.memoryStorage(),  // ⬅️ INI YANG BENER BUAT RAILWAY!
    limits: { fileSize: 20 * 1024 * 1024 }
});

// ==========================================
// ROUTE: UPLOAD AUDIO
// ==========================================
app.post('/api/upload', upload.single('audio'), async (req, res) => {
    try {
        const apiKey = req.headers['x-api-key'] || process.env.ROBLOX_API_KEY;
        const userId = req.headers['x-user-id'] || process.env.ROBLOX_USER_ID;

        if (!apiKey || !userId) {
            return res.status(400).json({ 
                success: false, 
                error: 'API Key dan User ID diperlukan!' 
            });
        }

        if (!req.file) {
            return res.status(400).json({ 
                success: false, 
                error: 'File audio diperlukan!' 
            });
        }

        // KIRIM KE ROBLOX
        const form = new FormData();
        form.append('file', req.file.buffer, {
            filename: req.file.originalname,
            contentType: req.file.mimetype
        });

        const response = await axios.post(
            'https://apis.roblox.com/assets/v1/assets/upload',
            form,
            {
                headers: {
                    ...form.getHeaders(),
                    'x-api-key': apiKey,
                    'x-user-id': userId
                },
                timeout: 30000
            }
        );

        res.json({
            success: true,
            assetId: response.data.assetId,
            url: `rbxassetid://${response.data.assetId}`,
            name: req.file.originalname,
            size: req.file.size
        });

    } catch (error) {
        console.error('Upload error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.message || 'Gagal upload'
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
            return res.status(400).json({ 
                success: false, 
                error: 'Music ID diperlukan!' 
            });
        }

        let script;
        if (useAC6) {
            script = `-- AC6 Music Spoof
local function playServerMusic(musicId, volume, pitch, loop)
    volume = volume or ${volume}
    pitch = pitch or 1
    loop = loop or ${loop}
    local args = {[1]="newSound",[2]="SpoofedMusic",[3]=workspace,[4]="rbxassetid://"..musicId,[5]=pitch,[6]=volume,[7]=loop}
    game:GetService("ReplicatedStorage"):WaitForChild("AC6_FE_Sounds"):FireServer(unpack(args))
    game:GetService("ReplicatedStorage"):WaitForChild("AC6_FE_Sounds"):FireServer("playSound", "SpoofedMusic")
    print("✅ Musik diputar! ID: "..musicId)
end
playServerMusic("${musicId}")`;
        } else {
            script = `-- Simple Audio Spoof
local sound = Instance.new("Sound")
sound.SoundId = "rbxassetid://${musicId}"
sound.Volume = ${volume}
sound.Looped = ${loop}
sound.Parent = workspace
sound:Play()
print("✅ Audio diputar! ID: ${musicId}")`;
        }

        res.json({ success: true, script, musicId, method: useAC6 ? 'AC6 Exploit' : 'Simple Spoof' });

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
        if (!script) {
            return res.status(400).json({ success: false, error: 'Script diperlukan!' });
        }
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

        if (!apiKey) {
            return res.status(400).json({ success: false, error: 'API Key diperlukan!' });
        }

        const response = await axios.get(
            `https://apis.roblox.com/assets/v1/assets/${assetId}`,
            { headers: { 'x-api-key': apiKey }, timeout: 10000 }
        );

        res.json({
            success: true,
            assetId: assetId,
            url: `rbxassetid://${assetId}`,
            data: response.data
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.message || 'Asset tidak ditemukan'
        });
    }
});

// ==========================================
// ROUTE: HEALTH CHECK
// ==========================================
app.get('/api/health', (req, res) => {
    res.json({ 
        status: '🔥 SirLion Spoof Music Running!', 
        timestamp: new Date(),
        port: PORT
    });
});

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🔥 SirLion Spoof Music running on port ${PORT}`);
});
