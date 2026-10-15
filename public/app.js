const socket = io({ autoConnect: false });
let currentUser = '';
let allUsers = [];
let targetUser = '';
let activePrivateRoom = '';
let tabHistory = [];

function showModal(icon, title, message) {
  document.getElementById('modal-icon').textContent = icon;
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-msg').textContent = message;
  document.getElementById('cartoon-modal').style.display = 'flex';
}

function closeModal() {
  document.getElementById('cartoon-modal').style.display = 'none';
}

function switchTab(paneId, button, remember = true) {
  const pane = document.getElementById(paneId);
  if (!pane) return;
  const currentPaneId = document.querySelector('.tab-pane.active')?.id;
  if (remember && currentPaneId && currentPaneId !== paneId) tabHistory.push(currentPaneId);
  document.querySelectorAll('.tab-pane').forEach(item => item.classList.remove('active'));
  pane.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(nav => nav.classList.remove('active'));
  const navId = paneId === 'private-chat-win' ? 'private-inbox' : paneId;
  const activeNav = document.querySelector(`.nav-btn[onclick*="'${navId}'"]`);
  if (activeNav) activeNav.classList.add('active');
  if (button?.classList.contains('nav-btn')) button.classList.add('active');
  closeSidebar();
  updateBackButton();
}

function updateBackButton() {
  const button = document.getElementById('global-back');
  if (button) button.hidden = tabHistory.length === 0;
}

function goBack() {
  const previousPane = tabHistory.pop();
  if (previousPane) switchTab(previousPane, null, false);
  else updateBackButton();
}

function toggleSidebar(forceOpen) {
  const sidebar = document.getElementById('app-sidebar');
  const toggle = document.getElementById('menu-toggle');
  const backdrop = document.getElementById('sidebar-backdrop');
  const open = typeof forceOpen === 'boolean' ? forceOpen : !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', open);
  sidebar.setAttribute('aria-hidden', String(!open));
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close sidebar' : 'Open sidebar');
  backdrop.hidden = !open;
}

function closeSidebar() {
  if (document.getElementById('app-sidebar')) toggleSidebar(false);
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
  return data;
}

async function register() {
  const username = document.getElementById('auth-user').value.trim();
  const password = document.getElementById('auth-pass').value;
  if (!username || !password) return showModal('⚠️', 'Missing details', 'Username နဲ့ password ဖြည့်ပါ။');
  try {
    const data = await jsonRequest('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    showModal('🎉', 'Account ready!', data.message || 'အကောင့်ဖွင့်ခြင်း အောင်မြင်ပါသည်။');
  } catch (error) {
    showModal('🙈', 'Could not register', error.message);
  }
}

async function login() {
  const username = document.getElementById('auth-user').value.trim();
  const password = document.getElementById('auth-pass').value;
  if (!username || !password) return showModal('⚠️', 'Missing details', 'Username နဲ့ password ဖြည့်ပါ။');
  try {
    const data = await jsonRequest('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    enterApp(data.username);
  } catch (error) {
    showModal('🙈', 'Login failed', error.message);
  }
}

function privateRoom(userA, userB) {
  return `private:${[userA, userB].sort().map(encodeURIComponent).join(':')}`;
}

function conversationStorageKey() {
  return `flash.private.${currentUser}`;
}

function getConversations() {
  try { return JSON.parse(localStorage.getItem(conversationStorageKey()) || '[]'); }
  catch { return []; }
}

function saveConversation(username) {
  const conversations = [username, ...getConversations().filter(name => name !== username)].slice(0, 100);
  localStorage.setItem(conversationStorageKey(), JSON.stringify(conversations));
  renderConversations();
}

async function loadUsers() {
  try {
    allUsers = await jsonRequest('/api/users');
    filterUsers();
  } catch (error) {
    document.getElementById('friends-list').replaceChildren(makeNotice(error.message));
  }
}

function makeNotice(text, className = 'empty-state') {
  const notice = document.createElement('div');
  notice.className = className;
  notice.textContent = text;
  return notice;
}

function filterUsers() {
  const query = (document.getElementById('search-friend')?.value || '').trim().toLowerCase();
  const candidates = allUsers.filter(user => user.username !== currentUser && user.username.toLowerCase().includes(query));
  const container = document.getElementById('friends-list');
  container.replaceChildren();
  if (!candidates.length) {
    container.append(makeNotice(query ? 'ဒီနာမည်နဲ့ ကိုက်ညီတဲ့သူ မတွေ့ပါ။' : 'မိတ်ဆွေအကောင့် မရှိသေးပါ။'));
    return;
  }
  candidates.forEach(user => {
    const button = document.createElement('button');
    button.className = 'user-item';
    button.type = 'button';
    button.addEventListener('click', () => openPrivateChat(user.username));
    const avatar = document.createElement('span');
    avatar.className = 'user-avatar';
    avatar.textContent = [...user.username][0]?.toUpperCase() || '?';
    const copy = document.createElement('span');
    copy.className = 'user-copy';
    const name = document.createElement('strong');
    name.textContent = user.username;
    const hint = document.createElement('small');
    hint.textContent = 'Tap to start a private chat';
    copy.append(name, hint);
    const arrow = document.createElement('i');
    arrow.className = 'fa-solid fa-chevron-right user-arrow';
    button.append(avatar, copy, arrow);
    container.append(button);
  });
}

function renderConversations() {
  const container = document.getElementById('private-conversations');
  container.replaceChildren();
  const conversations = getConversations();
  if (!conversations.length) {
    const empty = makeNotice('စကားပြောထားသူ မရှိသေးပါ။ Search Friends မှာ လူတစ်ယောက်ကို ရွေးပြီး စတင်ပြောပါ။');
    empty.classList.add('empty-card');
    container.append(empty);
    return;
  }
  conversations.forEach(username => {
    const button = document.createElement('button');
    button.className = 'user-item conversation-item';
    button.type = 'button';
    button.addEventListener('click', () => openPrivateChat(username, false));
    const avatar = document.createElement('span');
    avatar.className = 'user-avatar bubble-avatar';
    avatar.textContent = [...username][0]?.toUpperCase() || '?';
    const copy = document.createElement('span');
    copy.className = 'user-copy';
    const name = document.createElement('strong');
    name.textContent = username;
    const hint = document.createElement('small');
    hint.textContent = 'Open conversation';
    copy.append(name, hint);
    button.append(avatar, copy);
    container.append(button);
  });
}

function openPrivateChat(username, remember = true) {
  if (!username || username === currentUser) return;
  targetUser = username;
  activePrivateRoom = privateRoom(currentUser, targetUser);
  document.getElementById('target-username').textContent = targetUser;
  document.getElementById('private-logs').replaceChildren();
  if (remember) saveConversation(username);
  switchTab('private-chat-win');
  if (socket.connected) socket.emit('join_room', activePrivateRoom);
  document.getElementById('private-msg').focus();
}

function addChatMessage(container, data, kind) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${data.user === currentUser ? 'me' : 'other'}`;
  const author = document.createElement('strong');
  author.className = 'message-author';
  author.textContent = kind === 'ai' ? 'AI' : data.user;
  const content = document.createElement('span');
  content.className = 'message-text';
  content.textContent = data.msg ?? data.text ?? '';
  bubble.append(author, content);
  container.append(bubble);
  container.scrollTop = container.scrollHeight;
}

function renderRoomHistory({ room, messages }) {
  const container = room === 'group:global'
    ? document.getElementById('group-logs')
    : room === activePrivateRoom ? document.getElementById('private-logs') : null;
  if (!container) return;
  container.replaceChildren();
  (messages || []).forEach(message => addChatMessage(container, message, 'chat'));
}

function sendPrivateMsg() {
  const input = document.getElementById('private-msg');
  const msg = input.value.trim();
  if (!msg || !activePrivateRoom) return;
  if (!socket.connected) return showModal('🔌', 'Chat is reconnecting', 'Connection ပြန်ချိတ်ပြီးမှ စာပို့နိုင်ပါမယ်။');
  socket.emit('send_message', { room: activePrivateRoom, msg });
  input.value = '';
  input.focus();
}

function sendGroupMsg() {
  const input = document.getElementById('group-msg');
  const msg = input.value.trim();
  if (!msg) return;
  if (!socket.connected) return showModal('🔌', 'Chat is reconnecting', 'Connection ပြန်ချိတ်ပြီးမှ စာပို့နိုင်ပါမယ်။');
  socket.emit('send_message', { room: 'group:global', msg });
  input.value = '';
  input.focus();
}

socket.on('connect', () => {
  document.querySelectorAll('.live-pill').forEach(pill => { pill.classList.remove('offline'); pill.lastChild.textContent = ' LIVE'; });
  socket.emit('join_room', 'group:global');
  if (activePrivateRoom) socket.emit('join_room', activePrivateRoom);
});
socket.on('connect_error', () => {
  // The chat composer remains visible; show a clear status without repeatedly interrupting the user.
  document.querySelectorAll('.live-pill').forEach(pill => {
    pill.classList.add('offline');
    pill.lastChild.textContent = ' OFFLINE';
  });
});
socket.on('room_history', renderRoomHistory);
socket.on('receive_message', data => {
  if (data.room === 'group:global') {
    addChatMessage(document.getElementById('group-logs'), data, 'chat');
    return;
  }
  if (data.room === activePrivateRoom) addChatMessage(document.getElementById('private-logs'), data, 'chat');
});

async function sendAiPrompt() {
  const input = document.getElementById('ai-prompt');
  const prompt = input.value.trim();
  if (!prompt) return;
  const logs = document.getElementById('ai-logs');
  if (logs.querySelector('.welcome-card')) logs.replaceChildren();
  addChatMessage(logs, { user: currentUser, msg: prompt }, 'chat');
  input.value = '';
  const waiting = makeNotice('Thinking…', 'chat-bubble other typing-indicator');
  logs.append(waiting);
  try {
    const data = await jsonRequest('/api/ai/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: document.getElementById('ai-provider').value, prompt })
    });
    waiting.remove();
    addChatMessage(logs, { text: data.text || '(No response)' }, 'ai');
  } catch (error) {
    waiting.remove();
    addChatMessage(logs, { text: error.message }, 'ai');
  }
}

async function refreshKeyStatus() {
  const providers = ['gemini', 'groq', 'deepseek', 'openai', 'xai', 'manus'];
  try {
    const data = await jsonRequest('/api/settings');
    providers.forEach(provider => {
      const status = document.getElementById(`${provider}-key-status`);
      if (status) status.textContent = data[`${provider}Configured`] ? 'Saved for your account' : 'Not saved';
    });
  } catch (error) { showModal('⚠️', 'Settings unavailable', error.message); }
}

async function saveSettings(provider) {
  const input = document.getElementById(`${provider}-key`);
  const key = input.value.trim();
  if (!key) return showModal('🔑', 'Add a key first', 'သိမ်းလိုတဲ့ API key ကို ဖြည့်ပါ။');
  try {
    const data = await jsonRequest('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [`${provider}Key`]: key })
    });
    input.value = '';
    await refreshKeyStatus();
    showModal('🔐', 'Saved privately', data.message);
  } catch (error) { showModal('😿', 'Could not save key', error.message); }
}

async function clearApiKey(provider) {
  if (!confirm(`${provider} API key ကို သင့် account မှ ဖယ်ရှားမှာ သေချာပါသလား?`)) return;
  try {
    await jsonRequest('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [`clear${provider[0].toUpperCase()}${provider.slice(1)}`]: true })
    });
    await refreshKeyStatus();
    showModal('🧹', 'Key removed', `${provider} key ကို ဖယ်ရှားပြီးပါပြီ။`);
  } catch (error) { showModal('😿', 'Could not remove key', error.message); }
}

function enterApp(username) {
  currentUser = username;
  tabHistory = [];
  document.getElementById('auth-container').style.display = 'none';
  document.getElementById('app-container').style.display = 'flex';
  switchTab('ai-chat', null, false);
  renderConversations();
  loadUsers();
  refreshKeyStatus();
  if (!socket.connected) socket.connect();
}

async function restoreSession() {
  try {
    const data = await jsonRequest('/api/me');
    if (data.loggedIn && data.username) enterApp(data.username);
  } catch (error) {
    console.warn('Session restore failed:', error.message);
  }
}

async function logout() {
  try {
    await jsonRequest('/api/logout', { method: 'POST' });
    socket.disconnect();
    currentUser = '';
    targetUser = '';
    activePrivateRoom = '';
    tabHistory = [];
    closeSidebar();
    updateBackButton();
    document.getElementById('app-container').style.display = 'none';
    document.getElementById('auth-container').style.display = 'flex';
    document.getElementById('auth-pass').value = '';
    document.getElementById('auth-user').value = '';
    showModal('👋', 'See you soon!', 'အကောင့်မှ ထွက်ပြီးပါပြီ။');
  } catch (error) { showModal('😿', 'Logout failed', error.message); }
}

document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.getElementById('app-sidebar').classList.contains('open')) closeSidebar();
  });
  document.querySelectorAll('#ai-prompt, #private-msg, #group-msg').forEach(input => {
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (input.id === 'ai-prompt') sendAiPrompt();
        if (input.id === 'private-msg') sendPrivateMsg();
        if (input.id === 'group-msg') sendGroupMsg();
      }
    });
  });
  document.getElementById('auth-pass').addEventListener('keydown', event => { if (event.key === 'Enter') login(); });
  restoreSession();
});
