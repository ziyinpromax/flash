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
  if (!users || users.length <= 1) {
    container.innerHTML = '<p style="padding:15px;color:#888;">မိတ်ဆွေ အကောင့်မရှိသေးပါ</p>';
    return;
  }
  container.innerHTML = users.filter(u => u.username !== currentUser).map(u => `
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

async function downloadVideo() {
  const url = document.getElementById('dl-url').value;
  const resultDiv = document.getElementById('dl-result');
  resultDiv.innerText = 'Extracting Link...';

  const res = await fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
  const data = await res.json();
  if (data.success) {
    resultDiv.innerHTML = `<a href="${data.downloadUrl}" target="_blank"><button class="btn-primary">Download Video</button></a>`;
  } else {
    resultDiv.innerText = 'Download မရပါ: ' + (data.error || '');
  }
}

async function uploadMusic() {
  const fileInput = document.getElementById('music-file');
  const folderName = document.getElementById('folder-name').value.trim() || 'General';
  if (!fileInput.files[0]) return alert('MP3 ဖိုင် ရွေးချယ်ပါ');

  const formData = new FormData();
  formData.append('audio', fileInput.files[0]);
  formData.append('folder', folderName);

  await fetch('/api/music/upload', { method: 'POST', body: formData });
  document.getElementById('music-file').value = '';
  loadMusic();
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
