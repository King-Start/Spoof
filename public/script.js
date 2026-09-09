// script.js - SirLion Spoof Music
const API_BASE = window.location.origin;

let uploadedFile = null;
let lastSpoofedId = null;

// ===== API KEY =====
function saveApiKey() {
    const apiKey = document.getElementById('apiKeyInput').value;
    const userId = document.getElementById('userIdInput').value;
    const status = document.getElementById('apiStatus');
    
    if (!apiKey || !userId) {
        status.className = 'status error';
        status.textContent = '❌ API Key dan User ID wajib diisi!';
        return;
    }
    
    localStorage.setItem('roblox_api_key', apiKey);
    localStorage.setItem('roblox_user_id', userId);
    
    status.className = 'status success';
    status.textContent = '✅ API Key tersimpan!';
}

// ===== SPOOF AUDIO =====
function spoofAudio() {
    const assetId = document.getElementById('spoofIdInput').value;
    const result = document.getElementById('spoofResult');
    const loading = document.getElementById('spoofLoading');
    
    if (!assetId) {
        alert('Masukkan ID audio!');
        return;
    }
    
    const apiKey = localStorage.getItem('roblox_api_key');
    const userId = localStorage.getItem('roblox_user_id');
    
    if (!apiKey || !userId) {
        alert('Simpan API Key dan User ID dulu!');
        return;
    }
    
    // Show loading
    loading.classList.remove('hidden');
    result.classList.add('hidden');
    
    fetch(`${API_BASE}/api/spoof`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'x-user-id': userId
        },
        body: JSON.stringify({ assetId })
    })
    .then(res => res.json())
    .then(data => {
        loading.classList.add('hidden');
        
        if (data.success) {
            lastSpoofedId = data.newAssetId;
            document.getElementById('originalId').textContent = data.originalAssetId;
            document.getElementById('newId').textContent = data.newAssetId;
            document.getElementById('newUrl').textContent = data.url;
            result.classList.remove('hidden');
            
            // Auto-fill script input
            document.getElementById('scriptIdInput').value = data.newAssetId;
        } else {
            alert('❌ Gagal: ' + data.error);
        }
    })
    .catch(err => {
        loading.classList.add('hidden');
        alert('❌ Error: ' + err.message);
    });
}

function copyNewId() {
    const id = document.getElementById('newId')?.textContent;
    if (id) { navigator.clipboard.writeText(id); alert('✅ ID: ' + id); }
}

function copyNewUrl() {
    const url = document.getElementById('newUrl')?.textContent;
    if (url) { navigator.clipboard.writeText(url); alert('✅ URL: ' + url); }
}

// ===== GENERATE SCRIPT =====
function generateScript() {
    const musicId = document.getElementById('scriptIdInput').value;
    if (!musicId) { alert('Masukkan ID musik!'); return; }
    
    const volume = document.getElementById('volumeSlider').value;
    const loop = document.getElementById('loopScriptCheck').checked;
    const useAC6 = document.getElementById('useAC6Check').checked;
    
    const output = document.getElementById('scriptOutput');
    output.className = 'script-output';
    output.innerHTML = '<pre>⏳ Generating...</pre>';
    output.classList.remove('hidden');
    
    fetch(`${API_BASE}/api/generate-script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ musicId, volume, loop, useAC6 })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            output.innerHTML = `<pre id="scriptCode">${data.script}</pre>
                <button onclick="copyScript()">📋 Copy</button>
                <button onclick="downloadScript()">💾 Download</button>`;
        } else {
            output.innerHTML = `<pre style="color: #f00;">❌ ${data.error}</pre>`;
        }
    })
    .catch(err => {
        output.innerHTML = `<pre style="color: #f00;">❌ ${err.message}</pre>`;
    });
}

function copyScript() {
    const code = document.getElementById('scriptCode')?.textContent;
    if (code) { navigator.clipboard.writeText(code); alert('✅ Script di-copy!'); }
}

function downloadScript() {
    const code = document.getElementById('scriptCode')?.textContent;
    if (code) {
        fetch(`${API_BASE}/api/download-script`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ script: code, filename: 'spoof.lua' })
        })
        .then(res => res.blob())
        .then(blob => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'spoof_music.lua';
            a.click();
            URL.revokeObjectURL(url);
        });
    }
}

// ===== VOLUME SLIDER =====
document.getElementById('volumeSlider').addEventListener('input', function() {
    document.getElementById('volumeValue').textContent = this.value;
});

// ===== LOOKUP ASSET =====
function lookupAsset() {
    const id = document.getElementById('lookupId').value;
    const result = document.getElementById('lookupResult');
    if (!id) { alert('Masukkan ID!'); return; }
    
    const apiKey = localStorage.getItem('roblox_api_key');
    result.className = 'result';
    result.innerHTML = '⏳ Loading...';
    result.classList.remove('hidden');
    
    fetch(`${API_BASE}/api/asset/${id}`, {
        headers: { 'x-api-key': apiKey || '' }
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            result.innerHTML = `
                <p>✅ Asset ditemukan!</p>
                <p>🎵 ID: ${data.assetId}</p>
                <p>🔗 URL: <span class="highlight">${data.url}</span></p>
            `;
        } else {
            result.innerHTML = `<p style="color: #f00;">❌ ${data.error}</p>`;
        }
    })
    .catch(err => {
        result.innerHTML = `<p style="color: #f00;">❌ ${err.message}</p>`;
    });
}

// ===== LOAD SAVED API KEY =====
document.addEventListener('DOMContentLoaded', () => {
    const key = localStorage.getItem('roblox_api_key');
    const uid = localStorage.getItem('roblox_user_id');
    if (key) document.getElementById('apiKeyInput').value = key;
    if (uid) document.getElementById('userIdInput').value = uid;
});
