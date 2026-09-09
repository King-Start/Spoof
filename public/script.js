// ==========================================
// SIRLION SPOOF MUSIC - FRONTEND
// ==========================================

let uploadedFile = null;

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

// ===== DROP ZONE =====
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = '#f7971e';
});

dropZone.addEventListener('dragleave', () => {
    dropZone.style.borderColor = 'rgba(255,255,255,0.2)';
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'rgba(255,255,255,0.2)';
    if (e.dataTransfer.files.length > 0) {
        handleFile(e.dataTransfer.files[0]);
    }
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleFile(e.target.files[0]);
    }
});

function handleFile(file) {
    uploadedFile = file;
    document.getElementById('fileName').textContent = file.name;
    document.getElementById('fileSize').textContent = (file.size / 1024).toFixed(2) + ' KB';
    document.getElementById('fileInfo').classList.remove('hidden');
    document.getElementById('uploadResult').classList.add('hidden');
}

// ===== UPLOAD =====
function uploadAudio() {
    if (!uploadedFile) {
        alert('Pilih file dulu!');
        return;
    }
    
    const apiKey = localStorage.getItem('roblox_api_key');
    const userId = localStorage.getItem('roblox_user_id');
    
    if (!apiKey || !userId) {
        alert('Simpan API Key dan User ID dulu!');
        return;
    }
    
    const formData = new FormData();
    formData.append('audio', uploadedFile);
    
    const result = document.getElementById('uploadResult');
    result.className = 'result';
    result.innerHTML = '⏳ Uploading...';
    result.classList.remove('hidden');
    
    fetch('/api/upload', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'x-user-id': userId
        },
        body: formData
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            document.getElementById('uploadedId').textContent = data.assetId;
            document.getElementById('uploadedUrl').textContent = data.url;
            result.innerHTML = `
                <p>✅ Upload Berhasil!</p>
                <p>🎵 ID: <span id="uploadedId">${data.assetId}</span></p>
                <p>🔗 URL: <span id="uploadedUrl">${data.url}</span></p>
                <button onclick="copyUploadedId()">📋 Copy ID</button>
                <button onclick="copyUploadedUrl()">📋 Copy URL</button>
            `;
            result.classList.remove('hidden');
        } else {
            result.innerHTML = `<p style="color: #f00;">❌ ${data.error}</p>`;
            result.classList.remove('hidden');
        }
    })
    .catch(err => {
        result.innerHTML = `<p style="color: #f00;">❌ ${err.message}</p>`;
        result.classList.remove('hidden');
    });
}

function copyUploadedId() {
    const id = document.getElementById('uploadedId')?.textContent;
    if (id) { navigator.clipboard.writeText(id); alert('✅ ID: ' + id); }
}

function copyUploadedUrl() {
    const url = document.getElementById('uploadedUrl')?.textContent;
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
    
    fetch('/api/generate-script', {
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
        fetch('/api/download-script', {
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
    
    fetch(`/api/asset/${id}`, {
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
