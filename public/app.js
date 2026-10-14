const socket = io();
let currentUser = '';
let targetUser = '';
let allUsers = [];

// Custom Cartoon Popup Modal Logic
function showModal(icon, title, msg, showProgress = false) {
  document.getElementById('modal-icon').innerText = icon;
  document.getElementById('modal-title').innerText = title;
  document.getElementById('modal-msg').innerText = msg;
  
  const progContainer = document.getElementById('progress-container');
  progContainer.style.display = showProgress ? 'block' : 'none';
  if (showProgress) updateProgress(0);

  document.getElementById('cartoon-modal').style.display = 'flex';
}

function updateProgress(percent) {
  document.getElementById('progress-bar-fill').style.width = percent + '%';
  document.getElementById('progress-text').innerText = percent + '%';
}

function closeModal() {
  document.getElementById('cartoon-modal').style.display = 'none';
}

function switchTab(paneId, btn) {
  document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
  document.getElementById(paneId).classList.add('active');
  if (btn) {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }
}

async function register() {
  const username = document.getElementById('auth-user').value.trim();
  const password = document.getElementById('auth-pass').value.trim();
  if (!username || !password) return showModal('⚠️', 'Attention', 'Username နှင့် Password ဖြည့်ပါ!');

  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  showModal(data.success ? '🎉' : '❌', data.success ? 'Success' : 'Error', data.message);
}

async function login() {
  const username = document.getElementById('auth-user').value.trim();
  const password = document.getElementById('auth-pass').value.trim();
  if (!username || !password) return showModal('⚠️', 'Attention', 'Username နှင့် Password ဖြည့်ပါ!');

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (data.success) {
    currentUser = data.username;
    document.getElementById('auth-container').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';
    
    socket.emit('join_room', 'GlobalGroup');
    loadUsers();
    loadMusic();
  } else {
    showModal('❌', 'Login Failed', data.message);
  }
}

async function loadUsers() {
  const res = await fetch('/api/users');
  allUsers = await res.json();
  renderUsers(allUsers);
}

function renderUsers(users) {
  const container = document.getElementById('friends-list');
  const filtered = users.filter(u => u.username !== currentUser);

  if (!filtered || filtered.length === 0) {
    container.innerHTML = '<p style="padding:15px;color:#888;">မိတ်ဆွေ အကောင့်မရှိသေးပါ</p>';
    return;
  }

  container.innerHTML = filtered.map(u => `
    <div class="user-item" onclick="openPrivateChat('${u.username}')">
      <div style="width:40px;height:40px;border-radius:50%;background:#0084ff;color:white;display:flex;align-items:center;justify-content:center;font-weight:bold;margin-right:12px;">
        ${u.username.charAt(0).toUpperCase()}
      </div>
      <div>
        <div style="font-weight:bold;">${u.username}</div>
        <div style="font-size:12px;color:#777;">Click to message</div>
      </div>
    </div>
  `).join('');
}

function filterUsers() {
  const query = document.getElementById('search-friend').value.toLowerCase();
  const filtered = allUsers.filter(u => u.username.toLowerCase().includes(query));
  renderUsers(filtered);
}

function openPrivateChat(user) {
  targetUser = user;
  document.getElementById('target-username').innerText = targetUser;
  switchTab('private-chat-win');
  const roomId = [currentUser, targetUser].sort().join('_');
  socket.emit('join_room', roomId);
}

function sendPrivateMsg() {
  const msg = document.getElementById('private-msg').value.trim();
  if (!msg) return;
  const roomId = [currentUser, targetUser].sort().join('_');
  socket.emit('send_message', { room: roomId, user: currentUser, msg });
  document.getElementById('private-msg').value = '';
}

function sendGroupMsg() {
  const msg = document.getElementById('group-msg').value.trim();
  if (!msg) return;
  socket.emit('send_message', { room: 'GlobalGroup', user: currentUser, msg });
  document.getElementById('group-msg').value = '';
}

socket.on('receive_message', (data) => {
  const isMe = data.user === currentUser;
  const bubble = `<div class="chat-bubble ${isMe ? 'me' : 'other'}"><b>${data.user}:</b> ${data.msg}</div>`;
  if (data.room === 'GlobalGroup') {
    document.getElementById('group-logs').innerHTML += bubble;
  } else {
    document.getElementById('private-logs').innerHTML += bubble;
  }
});

async function sendAiPrompt() {
  const provider = document.getElementById('ai-provider').value;
  const prompt = document.getElementById('ai-prompt').value.trim();
  if (!prompt) return;
  const logs = document.getElementById('ai-logs');

  logs.innerHTML += `<div class="chat-bubble me">${prompt}</div>`;
  document.getElementById('ai-prompt').value = '';

  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, prompt })
  });
  const data = await res.json();
  logs.innerHTML += `<div class="chat-bubble other"><b>AI:</b> ${data.text || data.error}</div>`;
}

// Video Downloader Engine with Progress
async function downloadVideo() {
  const url = document.getElementById('dl-url').value.trim();
  const resultDiv = document.getElementById('dl-result');
  if (!url) return showModal('⚠️', 'Attention', 'Video Link ထည့်ပါ');

  showModal('⏳', 'Extracting Video', 'ဗီဒီယို လင့်ခ် ထုတ်ယူနေပါသည်...', true);
  updateProgress(40);

  const res = await fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
  const data = await res.json();
  updateProgress(100);

  setTimeout(() => {
    closeModal();
    if (data.success) {
      resultDiv.innerHTML = `<a href="${data.downloadUrl}" target="_blank"><button class="btn-primary">📥 Click to Download Video</button></a>`;
    } else {
      showModal('❌', 'Error', 'Video extraction failed!');
    }
  }, 400);
}

// Music Upload with Exact % Progress Tracking
function uploadMusic() {
  const fileInput = document.getElementById('music-file');
  const folderName = document.getElementById('folder-name').value.trim() || 'General';
  if (!fileInput.files[0]) return showModal('⚠️', 'Attention', 'MP3 ဖိုင် ရွေးချယ်ပါ!');

  const formData = new FormData();
  formData.append('audio', fileInput.files[0]);
  formData.append('folder', folderName);

  showModal('☁️', 'Uploading MP3', 'သီချင်း Upload တင်နေပါသည်...', true);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/music/upload', true);

  xhr.upload.onprogress = function (e) {
    if (e.lengthComputable) {
      const percentComplete = Math.round((e.loaded / e.total) * 100);
      updateProgress(percentComplete);
    }
  };

  xhr.onload = function () {
    if (xhr.status === 200) {
      setTimeout(() => {
        closeModal();
        showModal('🎉', 'Success', 'သီချင်း တင်ခြင်း အောင်မြင်ပါသည်!');
        document.getElementById('music-file').value = '';
        loadMusic();
      }, 300);
    } else {
      closeModal();
      showModal('❌', 'Failed', 'Upload တင်၍ မရပါ!');
    }
  };

  xhr.send(formData);
}

async function loadMusic() {
  const res = await fetch('/api/music/list');
  const list = await res.json();
  const div = document.getElementById('music-list');

  if (!list || list.length === 0) {
    div.innerHTML = '<p style="color:#888;">သီချင်း မရှိသေးပါ</p>';
    return;
  }

  div.innerHTML = list.map(m => `
    <div class="music-card">
      <div class="music-header">
        <div>
          <b>📂 [${m.folder || 'General'}] ${m.title}</b>
          <div style="font-size:12px;color:#666;">Uploaded by: ${m.uploader}</div>
        </div>
        ${m.uploader === currentUser ? `<button class="delete-btn" onclick="deleteMusic(${m.id})">Delete</button>` : ''}
      </div>
      <audio controls src="${m.file_url}" style="width:100%;"></audio>
    </div>
  `).join('');
}

async function deleteMusic(id) {
  if (!confirm('ဒီသီချင်းကို ဖျက်မှာ သေချာပါသလား?')) return;
  await fetch(`/api/music/delete/${id}`, { method: 'DELETE' });
  loadMusic();
}

async function saveSettings() {
  const geminiKey = document.getElementById('gemini-key').value;
  const groqKey = document.getElementById('groq-key').value;
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ geminiKey, groqKey })
  });
  showModal('💾', 'Saved', 'API Keys သိမ်းဆည်းပြီးပါပြီ!');
}
