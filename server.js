
---

## 📄 **FILE 5: server.js (BACKEND)**

```javascript
// ==========================================
// SIRLION SPOOF MUSIC - SERVER
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
app.use(express.static('public'));

// Setup upload
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage,
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

        const fileBuffer = fs.readFileSync(req.file.path);
        const fileName = req.file.originalname;

        // Upload ke Roblox Open Cloud
        const form = new FormData();
        form.append('file', fileBuffer, {
            filename: fileName,
            contentType: req.file.mimetype
        });

        const uploadUrl = `https://apis.roblox.com/assets/v1/assets/upload`;

        const response = await axios.post(uploadUrl, form, {
            headers: {
                ...form.getHeaders(),
                'x-api-key': apiKey,
                'x-user-id': userId
            }
        });

        fs.unlinkSync(req.file.path);

        res.json({
            success: true,
            assetId: response.data.assetId,
            url: `rbxassetid://${response.data.assetId}`,
            name: fileName,
            size: req.file.size
        });

    } catch (error) {
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

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
        const { musicId, volume, loop, useAC6 } = req.body;

        if (!musicId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Music ID diperlukan!' 
            });
        }

        let script;

        if (useAC6) {
            script = `-- ==========================================
-- SIRLION AC6 MUSIC SPOOF
-- ==========================================

local function playServerMusic(musicId, volume, pitch, loop)
    volume = volume or ${volume || 1}
    pitch = pitch or 1
    loop = loop or ${loop || true}
    
    local args = {
        [1] = "newSound",
        [2] = "SpoofedMusic",
        [3] = workspace,
        [4] = "rbxassetid://" .. musicId,
        [5] = pitch,
        [6] = volume,
        [7] = loop
    }
    
    game:GetService("ReplicatedStorage"):WaitForChild("AC6_FE_Sounds"):FireServer(unpack(args))
    game:GetService("ReplicatedStorage"):WaitForChild("AC6_FE_Sounds"):FireServer("playSound", "SpoofedMusic")
    
    print("✅ Musik diputar! ID: " .. musicId)
end

playServerMusic("${musicId}")`;
        } else {
            script = `-- ==========================================
-- SIRLION SIMPLE AUDIO SPOOF
-- ==========================================

local function spoofAudio(musicId, parent)
    parent = parent or workspace
    local sound = Instance.new("Sound")
    sound.SoundId = "rbxassetid://" .. musicId
    sound.Volume = ${volume || 1}
    sound.Pitch = 1
    sound.Looped = ${loop || true}
    sound.Parent = parent
    sound:Play()
    
    print("✅ Audio diputar dari ID: " .. musicId)
    return sound
end

spoofAudio("${musicId}")`;
        }

        res.json({
            success: true,
            script: script,
            musicId: musicId,
            method: useAC6 ? 'AC6 Exploit' : 'Simple Spoof'
        });

    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ==========================================
// ROUTE: DOWNLOAD SCRIPT
// ==========================================
app.post('/api/download-script', (req, res) => {
    try {
        const { script, filename } = req.body;

        if (!script) {
            return res.status(400).json({ 
                success: false, 
                error: 'Script diperlukan!' 
            });
        }

        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${filename || 'spoof.lua'}"`);
        res.send(script);

    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
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
            return res.status(400).json({ 
                success: false, 
                error: 'API Key diperlukan!' 
            });
        }

        const response = await axios.get(
            `https://apis.roblox.com/assets/v1/assets/${assetId}`,
            { headers: { 'x-api-key': apiKey } }
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
        timestamp: new Date() 
    });
});

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, () => {
    console.log(`
🔥 SIRLION SPOOF MUSIC 🔥
📡 Running on: http://localhost:${PORT}
🔑 API Key: ${process.env.ROBLOX_API_KEY ? '✅ Set' : '❌ Not Set'}
👤 User ID: ${process.env.ROBLOX_USER_ID ? '✅ Set' : '❌ Not Set'}
    `);
});
