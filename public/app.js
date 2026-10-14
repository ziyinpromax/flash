const socket = io();
let currentUser = '';
let currentRoom = 'Global';

function showSection(id) {
  document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
  document.getElementById(id).style.display = 'block';
}

async function register() {
  const username = document.getElementById('auth-user').value.trim();
  const password = document.getElementById('auth-pass').value.trim();

  // Empty Input Check
  if (!username || !password) {
    alert('ကျေးဇူးပြု၍ Username နှင့် Password ရိုက်ထည့်ပါ။');
    return;
  }

  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  alert(data.message || 'Registration completed!');
}

async function login() {
  const username = document.getElementById('auth-user').value.trim();
  const password = document.getElementById('auth-pass').value.trim();

  // Empty Input Check
  if (!username || !password) {
    alert('ကျေးဇူးပြု၍ Username နှင့် Password ရိုက်ထည့်ပါ။');
    return;
  }

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (data.success) {
    currentUser = data.username;
    document.getElementById('auth-container').style.display = 'none';
    document.getElementById('app-container').style.display = 'block';
    document.getElementById('user-display').innerText = `User: ${currentUser}`;
    joinRoom();
    loadMusic();
  } else {
    alert(data.message);
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
  alert('Settings saved to Supabase!');
}

async function sendAiPrompt() {
  const provider = document.getElementById('ai-provider').value;
  const model = document.getElementById('ai-model').value;
  const prompt = document.getElementById('ai-prompt').value;
  const logs = document.getElementById('ai-logs');

  logs.innerHTML += `<p><b>You:</b> ${prompt}</p>`;
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model, prompt })
  });
  const data = await res.json();
  logs.innerHTML += `<p><b>AI (${provider}):</b> ${data.text || data.error}</p>`;
}

async function downloadVideo() {
  const url = document.getElementById('dl-url').value;
  const resultDiv = document.getElementById('dl-result');
  resultDiv.innerText = 'Extracting Video Link...';
  const res = await fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
  const data = await res.json();
  if (data.success) {
    resultDiv.innerHTML = `<p>${data.title}</p><a href="${data.downloadUrl}" target="_blank"><button>Click to Download</button></a>`;
  } else {
    resultDiv.innerText = 'Download failed!';
  }
}

function joinRoom() {
  currentRoom = document.getElementById('chat-room').value;
  socket.emit('join_room', currentRoom);
}

function sendChatMessage() {
  const msg = document.getElementById('chat-msg').value;
  socket.emit('send_message', { room: currentRoom, user: currentUser, msg });
  document.getElementById('chat-msg').value = '';
}

socket.on('receive_message', (data) => {
  const logs = document.getElementById('chat-logs');
  logs.innerHTML += `<p><b>${data.user}:</b> ${data.msg}</p>`;
});

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
  const div = document.getElementById('music-list');
  div.innerHTML = list.map(m => `<div><p>${m.title} (by ${m.uploader})</p><audio controls src="${m.file_url}"></audio></div>`).join('');
}
