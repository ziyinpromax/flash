const socket = io();
let currentUser = '';
let targetUser = '';

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
  if (!username || !password) return alert('Username/Password ဖြည့်ပါ။');

  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  alert(data.message);
}

async function login() {
  const username = document.getElementById('auth-user').value.trim();
  const password = document.getElementById('auth-pass').value.trim();
  if (!username || !password) return alert('Username/Password ဖြည့်ပါ။');

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
    document.getElementById('sidebar-user-avatar').innerText = currentUser.charAt(0).toUpperCase();
    
    // Join Global Group
    socket.emit('join_room', 'GlobalGroup');
    loadUsers();
    loadMusic();
  } else {
    alert(data.message);
  }
}

async function loadUsers() {
  const res = await fetch('/api/users');
  const users = await res.json();
  const container = document.getElementById('friends-list');
  container.innerHTML = users.filter(u => u.username !== currentUser).map(u => `
    <div class="user-item" onclick="openPrivateChat('${u.username}')">
      <div style="width:40px;height:40px;border-radius:50%;background:#e4e6eb;display:flex;align-items:center;justify-content:center;font-weight:bold;margin-right:12px;">
        ${u.username.charAt(0).toUpperCase()}
      </div>
      <div>
        <div style="font-weight:bold;">${u.username}</div>
        <div style="font-size:12px;color:#777;">Click to message</div>
      </div>
    </div>
  `).join('');
}

function openPrivateChat(user) {
  targetUser = user;
  document.getElementById('target-username').innerText = targetUser;
  switchTab('private-chat-win');
  
  // Create Unique Room for Private Chat
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

async function downloadVideo() {
  const url = document.getElementById('dl-url').value;
  const resultDiv = document.getElementById('dl-result');
  resultDiv.innerText = 'Extracting link...';

  const res = await fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
  const data = await res.json();
  if (data.success) {
    resultDiv.innerHTML = `<br><a href="${data.downloadUrl}" target="_blank"><button class="btn-primary">Download Video</button></a>`;
  } else {
    resultDiv.innerText = 'Download မရပါ: ' + (data.error || '');
  }
}

async function saveSettings() {
  const geminiKey = document.getElementById('gemini-key').value;
  const groqKey = document.getElementById('groq-key').value;
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ geminiKey, groqKey })
  });
  alert('API Keys Saved!');
}

async function uploadMusic() {
  const fileInput = document.getElementById('music-file');
  const formData = new FormData();
  formData.append('audio', fileInput.files[0]);
  await fetch('/api/music/upload', { method: 'POST', body: formData });
  loadMusic();
}

async function loadMusic() {
  const res = await fetch('/api/music/list');
  const list = await res.json();
  document.getElementById('music-list').innerHTML = list.map(m => `
    <div style="padding:10px;border-bottom:1px solid #eee;">
      <p style="font-weight:bold;">${m.title}</p>
      <audio controls src="${m.file_url}" style="width:100%;margin-top:5px;"></audio>
    </div>
  `).join('');
}
