const socket = io({ autoConnect: false });
let currentUser = '';
let currentUserId = '';
let currentProfile = null;
let allUsers = [];
let targetUser = '';
let targetProfile = null;
let activePrivateRoom = '';
let activeTab = 'ai-chat';
let navigationHistory = [];
let currentAiConversationId = '';
let currentAiConversationTitle = '';
let pendingPrivateReply = null;
let pendingGroupReply = null;
let groupConversationPinned = false;
let groupConversationNickname = '';
let groupHiddenForMe = false;

function showModal(icon, title, message, showProgress = false) {
  document.getElementById('modal-icon').textContent = icon;
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-msg').textContent = message;
  document.getElementById('progress-container').style.display = showProgress ? 'block' : 'none';
  if (showProgress) updateProgress(0);
  document.getElementById('cartoon-modal').style.display = 'flex';
}
function updateProgress(percent) {
  const safe = Math.max(0, Math.min(100, Number(percent) || 0));
  document.getElementById('progress-bar-fill').style.width = `${safe}%`;
  document.getElementById('progress-text').textContent = `${safe}%`;
}
function closeModal() { document.getElementById('cartoon-modal').style.display = 'none'; }
function setProgress(prefix, percent, note = '') {
  const container = document.getElementById(`${prefix}-progress`);
  const fill = document.getElementById(`${prefix}-progress-fill`);
  const text = document.getElementById(`${prefix}-progress-text`);
  if (!container || !fill || !text) return;
  container.hidden = false;
  if (percent === null) {
    fill.style.width = '100%';
    fill.classList.add('indeterminate');
    text.textContent = note || 'Working…';
  } else {
    fill.classList.remove('indeterminate');
    const safe = Math.max(0, Math.min(100, Number(percent) || 0));
    fill.style.width = `${safe}%`;
    text.textContent = `${safe}%${note ? ` · ${note}` : ''}`;
  }
}
function hideProgress(prefix) {
  const container = document.getElementById(`${prefix}-progress`);
  const fill = document.getElementById(`${prefix}-progress-fill`);
  if (container) container.hidden = true;
  fill?.classList.remove('indeterminate');
}

function jsonRequest(url, options = {}) {
  return fetch(url, { credentials: 'same-origin', ...options }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
    return data;
  });
}
function xhrJsonRequest(url, options = {}, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method || 'GET', url, true);
    xhr.withCredentials = true;
    xhr.timeout = options.timeout || 30_000;
    Object.entries(options.headers || {}).forEach(([key, value]) => xhr.setRequestHeader(key, value));
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100), 'Sending'); };
    xhr.upload.onload = () => onProgress(null, 'Waiting for server');
    xhr.onerror = () => reject(new Error('Network ကိုစစ်ဆေးပြီး ထပ်ကြိုးစားပါ။'));
    xhr.onabort = () => reject(new Error('Request ကို ရပ်လိုက်ပါပြီ။'));
    xhr.ontimeout = () => reject(new Error('Server တုံ့ပြန်မှု အချိန်ကျော်သွားပါသည်။'));
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* non-JSON response */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || data.message || `Request failed (${xhr.status})`));
    };
    xhr.send(options.body || null);
  });
}
function displayName(profile) { return profile?.nickname || profile?.displayName || profile?.username || 'Unknown'; }
function switchTab(paneId, button) {
  const pane = document.getElementById(paneId);
  if (!pane) return;
  if (paneId !== activeTab) navigationHistory.push(activeTab);
  activateTab(paneId, button);
  closeSidebar();
}
function activateTab(paneId, button) {
  document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
  document.getElementById(paneId)?.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(nav => nav.classList.remove('active'));
  const navPaneId = paneId === 'private-chat-win' ? 'private-inbox' : paneId;
  const activeNav = document.querySelector(`.nav-btn[onclick*="'${navPaneId}'"]`);
  if (activeNav) activeNav.classList.add('active');
  if (button?.classList.contains('nav-btn')) button.classList.add('active');
  activeTab = paneId;
  if (paneId === 'private-inbox') loadConversations();
  if (paneId === 'profile') loadProfile();
  if (paneId === 'settings') refreshKeyStatus();
  if (paneId === 'music') loadMusic();
}
function goBack() {
  while (navigationHistory.length) {
    const previous = navigationHistory.pop();
    if (previous && document.getElementById(previous)) { activateTab(previous); return; }
  }
  if (activeTab === 'private-chat-win') return activateTab('private-inbox');
  if (activeTab !== 'ai-chat') return activateTab('ai-chat');
}
function toggleSidebar() { document.getElementById('app-container').classList.toggle('sidebar-open'); }
function closeSidebar() { document.getElementById('app-container').classList.remove('sidebar-open'); }
async function register() {
  const username = document.getElementById('auth-user').value.trim().toLowerCase();
  const display = document.getElementById('register-name').value.trim();
  const password = document.getElementById('auth-pass').value;
  showModal('⚡', 'Creating account', 'Account information ကို ပို့နေပါသည်…', true);
  try {
    const data = await xhrJsonRequest('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, displayName: display, password })
    }, (percent, phase) => {
      if (percent === null) { document.getElementById('modal-msg').textContent = phase || 'Waiting for server'; updateProgress(100); }
      else updateProgress(percent);
    });
    updateProgress(100);
    currentUser = data.username;
    const me = await jsonRequest('/api/me');
    currentUserId = me.userId;
    closeModal();
    enterApp(currentUser, currentUserId);
    showModal('🎉', 'Account ready!', data.message || 'Account ဖန်တီးပြီးပါပြီ။');
  } catch (error) { showModal('🙈', 'Could not register', error.message); }
}
async function login() {
  const username = document.getElementById('auth-user').value.trim().toLowerCase();
  const password = document.getElementById('auth-pass').value;
  showModal('🔐', 'Signing in', 'Login တောင်းဆိုမှုကို ပို့နေပါသည်…', true);
  try {
    const data = await xhrJsonRequest('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password })
    }, (percent, phase) => {
      if (percent === null) { document.getElementById('modal-msg').textContent = phase || 'Waiting for server'; updateProgress(100); }
      else updateProgress(percent);
    });
    updateProgress(100);
    closeModal();
    enterApp(data.username, data.userId);
  } catch (error) { showModal('🙈', 'Login failed', error.message); }
}
function conversationStorageKey() { return `flash.private.${currentUserId || currentUser}`; }
function getConversations() {
  try { return JSON.parse(localStorage.getItem(conversationStorageKey()) || '[]'); }
  catch { return []; }
}
function saveConversation(username) {
  const entries = [username, ...getConversations().filter(name => name !== username)].slice(0, 100);
  localStorage.setItem(conversationStorageKey(), JSON.stringify(entries));
}
async function loadUsers() {
  try { allUsers = await jsonRequest('/api/users'); filterUsers(); }
  catch (error) { document.getElementById('friends-list').replaceChildren(makeNotice(error.message)); }
}
function makeNotice(text, className = 'empty-state') {
  const notice = document.createElement('div');
  notice.className = className;
  notice.textContent = text;
  return notice;
}
function makeAvatar(profile, className = 'user-avatar') {
  if (profile?.avatarUrl) {
    const image = document.createElement('img');
    image.className = `${className} avatar-image`;
    image.alt = '';
    image.src = profile.avatarUrl;
    image.onerror = () => { image.replaceWith(makeInitialAvatar(profile, className)); };
    return image;
  }
  return makeInitialAvatar(profile, className);
}
function makeInitialAvatar(profile, className) {
  const avatar = document.createElement('span');
  avatar.className = className;
  avatar.textContent = [...(displayName(profile) || '?')][0]?.toUpperCase() || '?';
  return avatar;
}
function lastSeenText(profile) {
  if (profile?.online) return 'Online now';
  if (!profile?.lastSeenAt) return 'Offline';
  const elapsed = Math.max(0, Date.now() - new Date(profile.lastSeenAt).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'Offline · just now';
  if (minutes < 60) return `Offline · ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Offline · ${hours}h ago`;
  return `Offline · ${Math.floor(hours / 24)}d ago`;
}
function filterUsers() {
  const query = (document.getElementById('search-friend')?.value || '').trim().toLowerCase();
  const matches = allUsers.filter(user => `${user.username} ${user.displayName}`.toLowerCase().includes(query));
  const container = document.getElementById('friends-list');
  container.replaceChildren();
  if (!matches.length) return container.append(makeNotice('ဒီအမည်နဲ့ ကိုက်ညီသူ မတွေ့ပါ။'));
  matches.forEach(user => {
    const button = document.createElement('button');
    button.className = 'user-item'; button.type = 'button';
    button.addEventListener('click', () => openPrivateChat(user.username));
    button.append(makeAvatar(user));
    const copy = document.createElement('span'); copy.className = 'user-copy';
    const name = document.createElement('strong'); name.textContent = user.displayName || user.username;
    const hint = document.createElement('small'); hint.textContent = `@${user.username} · ${lastSeenText(user)}`;
    copy.append(name, hint); button.append(copy);
    if (user.online) { const dot = document.createElement('i'); dot.className = 'online-indicator'; button.append(dot); }
    container.append(button);
  });
}
function renderConversations(items) {
  const container = document.getElementById('private-conversations');
  container.replaceChildren();
  if (!items?.length) return container.append(makeNotice('စကားပြောထားသူ မရှိသေးပါ။ Search Friends မှာ လူတစ်ယောက်ကို ရွေးပြီး စာပို့ပါ။'));
  items.forEach(item => {
    const button = document.createElement('div');
    button.className = `user-item conversation-item${item.isPinned ? ' pinned' : ''}`;
    const peer = item.type === 'group' ? { displayName: item.nickname || 'Group Chat' } : item.peer;
    const open = document.createElement('button'); open.className = 'conversation-open'; open.type = 'button';
    open.addEventListener('click', () => item.type === 'group' ? openGroupChat() : openPrivateChat(item.peer?.username, false, item.peer));
    open.append(makeAvatar(peer, 'user-avatar bubble-avatar'));
    const copy = document.createElement('span'); copy.className = 'user-copy';
    const name = document.createElement('strong'); name.textContent = displayName(peer);
    const hint = document.createElement('small'); hint.textContent = item.lastMessage?.text || (item.type === 'group' ? 'Shared group conversation' : `@${peer?.username || ''} · ${lastSeenText(peer)}`);
    copy.append(name, hint); open.append(copy); button.append(open);
    if (item.isPinned) { const pinMark = document.createElement('i'); pinMark.className = 'fa-solid fa-thumbtack pin-mark'; button.append(pinMark); }
    if (item.type !== 'group') {
      const actions = document.createElement('span'); actions.className = 'list-actions';
      const pin = actionButton('fa-thumbtack', 'Pin conversation', async event => { event.stopPropagation(); await updateConversation(item.id, { isPinned: !item.isPinned }); });
      const rename = actionButton('fa-pen', 'Set nickname', async event => { event.stopPropagation(); const nickname = prompt('ဒီ conversation ထဲမှာ ဘယ်လိုအမည်နဲ့ ပြမလဲ?', item.nickname || ''); if (nickname !== null) await updateConversation(item.id, { nickname }); });
      const remove = actionButton('fa-trash', 'Delete conversation', async event => { event.stopPropagation(); if (confirm('ဒီ conversation ကို သင့်စာရင်းမှ ဖယ်ရှားမလား?')) await updateConversation(item.id, { isDeleted: true }); });
      actions.append(pin, rename, remove); button.append(actions);
    }
    container.append(button);
  });
}
function actionButton(icon, label, handler) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-button mini'; button.title = label; button.setAttribute('aria-label', label);
  const i = document.createElement('i'); i.className = `fa-solid ${icon}`; button.append(i); button.addEventListener('click', handler); return button;
}
async function loadConversations() {
  try {
    const items = await jsonRequest('/api/conversations');
    renderConversations(items);
    const group = items.find(item => item.type === 'group');
    groupHiddenForMe = !group;
    groupConversationPinned = Boolean(group?.isPinned);
    groupConversationNickname = group?.nickname || '';
    document.getElementById('group-conversation-title').textContent = `👨‍👩‍👧‍👦 ${groupConversationNickname || 'Group Chat'}`;
    document.getElementById('group-nav-button').hidden = groupHiddenForMe;
    document.getElementById('restore-group-button').hidden = !groupHiddenForMe;
  } catch (error) { document.getElementById('private-conversations').replaceChildren(makeNotice(error.message)); }
}
async function updateConversation(id, updates) {
  try {
    await jsonRequest(`/api/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
    if (id === activePrivateRoom && typeof updates.nickname === 'string' && targetProfile) {
      targetProfile = { ...targetProfile, nickname: updates.nickname.trim() };
      document.getElementById('target-username').textContent = displayName(targetProfile);
    }
    if (id === 'group:global' && typeof updates.nickname === 'string') {
      groupConversationNickname = updates.nickname.trim();
      document.getElementById('group-conversation-title').textContent = `👨‍👩‍👧‍👦 ${groupConversationNickname || 'Group Chat'}`;
    }
    await loadConversations();
  }
  catch (error) { showModal('⚠️', 'Conversation update failed', error.message); }
}
async function openPrivateChat(username, remember = true, profileHint = null) {
  if (!username || username === currentUser) return;
  try {
    const data = await jsonRequest('/api/conversations/private', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }) });
    targetUser = data.otherUser.username;
    targetProfile = profileHint || allUsers.find(user => user.id === data.otherUser.id) || data.otherUser;
    activePrivateRoom = data.conversationId;
    document.getElementById('target-username').textContent = displayName(targetProfile);
    document.getElementById('target-presence').textContent = `@${targetUser} · ${lastSeenText(targetProfile)}`;
    if (remember) saveConversation(targetUser);
    pendingPrivateReply = null; renderReplyPreview('private');
    if (activeTab !== 'private-chat-win') navigationHistory.push(activeTab);
    activateTab('private-chat-win'); closeSidebar();
    document.getElementById('private-msg').focus();
    const messages = await jsonRequest(`/api/conversations/${encodeURIComponent(activePrivateRoom)}/messages`);
    renderRoomHistory({ room: activePrivateRoom, messages });
    if (socket.connected) socket.emit('join_room', activePrivateRoom, result => { if (result?.success) socket.emit('mark_read', activePrivateRoom); });
  } catch (error) { showModal('⚠️', 'Chat could not open', error.message); }
}
async function openGroupChat() {
  if (groupHiddenForMe) return showModal('🗂️', 'Group hidden', 'Inbox မှာ Restore group ကိုနှိပ်ပြီး ပြန်ဖွင့်ပါ။');
  if (activeTab !== 'group-chat') navigationHistory.push(activeTab);
  activateTab('group-chat'); closeSidebar();
  if (socket.connected) socket.emit('join_room', 'group:global', result => { if (result?.success) socket.emit('mark_read', 'group:global'); });
  try { const messages = await jsonRequest('/api/conversations/group:global/messages'); renderRoomHistory({ room: 'group:global', messages }); }
  catch (error) { showModal('⚠️', 'Group chat unavailable', error.message); }
}
function renderRoomHistory({ room, messages }) {
  const container = room === 'group:global' ? document.getElementById('group-logs') : room === activePrivateRoom ? document.getElementById('private-logs') : null;
  if (!container) return;
  container.replaceChildren();
  (messages || []).forEach(message => addChatMessage(container, message));
  container.scrollTop = container.scrollHeight;
}
function statusLabel(status) {
  if (status === 'sending') return 'Sending…';
  if (status === 'sent') return 'Sent';
  if (status === 'delivered') return 'Delivered';
  if (status === 'seen') return 'Seen';
  if (status === 'not-sent') return 'Not sent';
  return '';
}
function addChatMessage(container, data) {
  const existing = data.id ? container.querySelector(`[data-message-id="${CSS.escape(data.id)}"]`) : null;
  if (existing) { updateRenderedMessage(existing, data); return existing; }
  if (data.clientId) container.querySelector(`[data-client-id="${CSS.escape(data.clientId)}"]`)?.remove();
  const bubble = document.createElement('article');
  bubble.className = `chat-bubble ${data.userId === currentUserId ? 'me' : 'other'}`;
  if (data.source === 'ai') bubble.classList.add('ai-message');
  if (data.id) bubble.dataset.messageId = data.id;
  if (data.userId) bubble.dataset.userId = data.userId;
  const head = document.createElement('div'); head.className = 'message-head';
  if (data.avatarUrl) { const photo = document.createElement('img'); photo.className = 'message-avatar'; photo.src = data.avatarUrl; photo.alt = ''; head.append(photo); }
  const author = document.createElement('strong'); author.className = 'message-author'; author.textContent = data.userId === currentUserId ? 'You' : (data.displayName || data.user || 'Unknown');
  head.append(author); bubble.append(head);
  if (data.replyTo) { const reply = document.createElement('small'); reply.className = 'reply-quote'; reply.textContent = `↪ Reply to message`; bubble.append(reply); }
  const content = document.createElement('span'); content.className = 'message-text'; content.textContent = data.deleted ? 'This message was deleted' : (data.msg ?? data.content ?? ''); bubble.append(content);
  if (data.edited) { const edited = document.createElement('small'); edited.className = 'edited-label'; edited.textContent = 'edited'; bubble.append(edited); }
  if (data.pinned) { const pin = document.createElement('small'); pin.className = 'pinned-label'; pin.textContent = '📌 Pinned'; bubble.append(pin); }
  const footer = document.createElement('div'); footer.className = 'message-footer';
  const status = document.createElement('small'); status.className = 'message-status'; status.textContent = data.userId === currentUserId ? statusLabel(data.status || 'sent') : '';
  footer.append(status);
  if (data.source !== 'ai') {
    const actions = document.createElement('div'); actions.className = 'message-actions';
    actions.append(actionButton('fa-reply', 'Reply', () => setReply(data, data.room === 'group:global' ? 'group' : 'private')));
    actions.append(actionButton(data.pinned ? 'fa-thumbtack-slash' : 'fa-thumbtack', data.pinned ? 'Unpin message' : 'Pin message', () => changeMessage(data.id, 'pin')));
    if (data.userId === currentUserId && !data.deleted) {
      actions.append(actionButton('fa-pen', 'Edit message', () => editMessage(data)));
      actions.append(actionButton('fa-trash', 'Delete message', () => deleteMessage(data)));
    }
    footer.append(actions);
  }
  bubble.append(footer);
  container.append(bubble);
  container.scrollTop = container.scrollHeight;
  return bubble;
}
function updateRenderedMessage(element, data) {
  element.querySelector('.message-text').textContent = data.deleted ? 'This message was deleted' : (data.msg ?? data.content ?? '');
  const status = element.querySelector('.message-status');
  if (status && data.userId === currentUserId) status.textContent = statusLabel(data.status || 'sent');
  element.classList.toggle('is-pinned', Boolean(data.pinned));
}
function setReply(message, kind) {
  if (kind === 'group') pendingGroupReply = message; else pendingPrivateReply = message;
  renderReplyPreview(kind);
  document.getElementById(kind === 'group' ? 'group-msg' : 'private-msg').focus();
}
function renderReplyPreview(kind) {
  const current = kind === 'group' ? pendingGroupReply : pendingPrivateReply;
  const container = document.getElementById(`${kind}-reply-preview`);
  container.replaceChildren(); container.hidden = !current;
  if (!current) return;
  const text = document.createElement('span'); text.textContent = `Replying to ${current.displayName || current.user}: ${(current.msg || '').slice(0, 80)}`;
  const close = document.createElement('button'); close.className = 'icon-button mini'; close.innerHTML = '<i class="fa-solid fa-xmark"></i>'; close.setAttribute('aria-label', 'Cancel reply');
  close.addEventListener('click', () => { if (kind === 'group') pendingGroupReply = null; else pendingPrivateReply = null; renderReplyPreview(kind); });
  container.append(text, close);
}
function changeMessage(id, action, content) {
  if (!id) return;
  jsonRequest(`/api/messages/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, content }) })
    .catch(error => showModal('⚠️', 'Message update failed', error.message));
}
function editMessage(message) {
  const edited = prompt('Message-ээ засварлана уу:', message.msg);
  if (edited !== null && edited.trim()) changeMessage(message.id, 'edit', edited.trim());
}
function deleteMessage(message) { if (confirm('ဒီ message ကို ဖျက်မလား?')) changeMessage(message.id, 'delete'); }
function sendMessage(room, inputId, kind) {
  const input = document.getElementById(inputId);
  const msg = input.value.trim();
  if (!msg || !room) return;
  const container = document.getElementById(kind === 'group' ? 'group-logs' : 'private-logs');
  const clientId = crypto.randomUUID();
  const reply = kind === 'group' ? pendingGroupReply : pendingPrivateReply;
  const pending = addChatMessage(container, { clientId, room, userId: currentUserId, user: currentUser, displayName: currentProfile?.displayName || currentUser, msg, status: 'sending', replyTo: reply?.id });
  pending.dataset.clientId = clientId;
  input.value = '';
  if (kind === 'group') pendingGroupReply = null; else pendingPrivateReply = null;
  renderReplyPreview(kind);
  const prefix = `${kind}-send`;
  setProgress(prefix, 0);
  xhrJsonRequest(`/api/conversations/${encodeURIComponent(room)}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: msg, replyTo: reply?.id || null, clientId })
  }, (percent, phase) => setProgress(prefix, percent, phase)).then(response => {
    setProgress(prefix, 100);
    const bubble = container.querySelector(`[data-client-id="${CSS.escape(clientId)}"]`);
    if (bubble && response.message) { bubble.remove(); addChatMessage(container, response.message); }
    loadConversations();
    setTimeout(() => hideProgress(prefix), 900);
  }).catch(error => {
    const bubble = container.querySelector(`[data-client-id="${CSS.escape(clientId)}"]`);
    if (bubble) { bubble.querySelector('.message-status').textContent = statusLabel('not-sent'); bubble.classList.add('message-failed'); }
    hideProgress(prefix);
    showModal('⚠️', 'Message not sent', error.message || 'Message မပို့နိုင်ပါ။');
  });
  input.focus();
}
function sendPrivateMsg() { sendMessage(activePrivateRoom, 'private-msg', 'private'); }
function sendGroupMsg() { sendMessage('group:global', 'group-msg', 'group'); }
async function pinCurrentConversation() {
  if (!activePrivateRoom) return;
  try {
    const items = await jsonRequest('/api/conversations');
    const current = items.find(item => item.id === activePrivateRoom);
    await updateConversation(activePrivateRoom, { isPinned: !current?.isPinned });
  } catch (error) { showModal('⚠️', 'Could not pin', error.message); }
}
async function renameCurrentConversation() {
  if (!activePrivateRoom) return;
  const nickname = prompt('ဒီ conversation ထဲမှာ သူ့ကို ဘယ်အမည်နဲ့ပြမလဲ?', targetProfile?.nickname || '');
  if (nickname !== null) await updateConversation(activePrivateRoom, { nickname });
}
async function deleteCurrentConversation() {
  if (activePrivateRoom && confirm('Conversation ကို သင့်စာရင်းမှ ဖယ်ရှားမလား?')) {
    await updateConversation(activePrivateRoom, { isDeleted: true });
    activateTab('private-inbox');
  }
}
async function pinGroupConversation() { await updateConversation('group:global', { isPinned: !groupConversationPinned }); }
async function renameGroupConversation() {
  const nickname = prompt('Group conversation ကို ကိုယ့်စာရင်းမှာ ဘယ်အမည်နဲ့ ပြမလဲ?', groupConversationNickname);
  if (nickname !== null) await updateConversation('group:global', { nickname });
}
async function deleteGroupConversation() {
  if (confirm('Group conversation ကို သင့်စာရင်းမှ ဖယ်ရှားမလား?')) {
    await updateConversation('group:global', { isDeleted: true });
    activateTab('private-inbox');
  }
}
async function restoreGroupConversation() { await updateConversation('group:global', { isDeleted: false }); }

socket.on('connect', () => {
  document.querySelectorAll('.live-pill').forEach(pill => { pill.classList.remove('offline'); pill.lastChild.textContent = ' LIVE'; });
  socket.emit('join_room', 'group:global', result => { if (result?.success && activeTab === 'group-chat') socket.emit('mark_read', 'group:global'); });
  if (activePrivateRoom) socket.emit('join_room', activePrivateRoom, result => { if (result?.success && activeTab === 'private-chat-win') socket.emit('mark_read', activePrivateRoom); });
});
socket.on('connect_error', () => document.querySelectorAll('.live-pill').forEach(pill => { pill.classList.add('offline'); pill.lastChild.textContent = ' OFFLINE'; }));
socket.on('room_history', renderRoomHistory);
socket.on('receive_message', data => {
  const container = data.room === 'group:global' ? document.getElementById('group-logs') : data.room === activePrivateRoom ? document.getElementById('private-logs') : null;
  const isActiveRoom = container && ((data.room === 'group:global' && activeTab === 'group-chat') || (data.room === activePrivateRoom && activeTab === 'private-chat-win'));
  if (isActiveRoom) {
    addChatMessage(container, data);
    if (data.userId !== currentUserId && socket.connected) socket.emit('mark_read', data.room);
  } else loadConversations();
});
socket.on('message_changed', data => {
  if (data.room === 'group:global') jsonRequest('/api/conversations/group%3Aglobal/messages').then(messages => renderRoomHistory({ room: 'group:global', messages })).catch(() => {});
  else if (data.room === activePrivateRoom) jsonRequest(`/api/conversations/${encodeURIComponent(data.room)}/messages`).then(messages => renderRoomHistory({ room: data.room, messages })).catch(() => {});
});
socket.on('receipt_update', receipt => {
  document.querySelectorAll(`[data-message-id="${CSS.escape(receipt.messageId)}"]`).forEach(element => {
    if (element.dataset.userId === currentUserId) element.querySelector('.message-status').textContent = statusLabel(receipt.status);
  });
});
socket.on('presence_update', update => {
  const index = allUsers.findIndex(user => user.id === update.userId);
  if (index >= 0) allUsers[index] = { ...allUsers[index], online: update.online, lastSeenAt: update.lastSeenAt || allUsers[index].lastSeenAt };
  filterUsers();
  if (targetProfile?.id === update.userId) {
    targetProfile = { ...targetProfile, online: update.online, lastSeenAt: update.lastSeenAt || targetProfile.lastSeenAt };
    document.getElementById('target-presence').textContent = `@${targetUser} · ${lastSeenText(targetProfile)}`;
  }
});
socket.on('profile_updated', profile => {
  const index = allUsers.findIndex(user => user.id === profile.id);
  if (index >= 0) allUsers[index] = { ...allUsers[index], ...profile };
  if (currentUserId === profile.id) currentProfile = profile;
  if (targetProfile?.id === profile.id) {
    targetProfile = { ...targetProfile, ...profile };
    targetUser = profile.username;
    document.getElementById('target-username').textContent = displayName(targetProfile);
    document.getElementById('target-presence').textContent = `@${targetUser} · ${lastSeenText(targetProfile)}`;
  }
  document.querySelectorAll(`.chat-bubble[data-user-id="${CSS.escape(profile.id)}"]`).forEach(bubble => {
    const author = bubble.querySelector('.message-author');
    if (author) author.textContent = profile.id === currentUserId ? 'You' : displayName(profile);
    const head = bubble.querySelector('.message-head');
    let avatar = head?.querySelector('.message-avatar');
    if (head && profile.avatarUrl) {
      if (!avatar) { avatar = document.createElement('img'); avatar.className = 'message-avatar'; avatar.alt = ''; head.insertBefore(avatar, head.firstChild); }
      avatar.src = profile.avatarUrl;
    } else if (avatar) avatar.remove();
  });
  filterUsers();
  loadConversations();
});

function toggleAiHistory() { document.getElementById('ai-history-panel').classList.toggle('history-hidden'); }
async function loadAiHistory() {
  const container = document.getElementById('ai-history-list');
  try {
    const items = await jsonRequest('/api/ai/conversations');
    container.replaceChildren();
    if (!items.length) return container.append(makeNotice('AI conversation မရှိသေးပါ။', 'empty-state small-empty'));
    items.forEach(item => {
      const row = document.createElement('div'); row.className = 'history-row';
      const button = document.createElement('button'); button.className = `history-item${item.id === currentAiConversationId ? ' active' : ''}`; button.type = 'button';
      const name = document.createElement('strong'); name.textContent = item.title;
      const provider = document.createElement('small'); provider.textContent = `${item.provider} · ${new Date(item.updated_at).toLocaleDateString()}`;
      button.append(name, provider); button.addEventListener('click', () => selectAiConversation(item));
      const remove = actionButton('fa-trash', 'Delete AI conversation', async () => { if (confirm('ဒီ AI history ကို ဖျက်မလား?')) { try { await jsonRequest(`/api/ai/conversations/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); if (currentAiConversationId === item.id) startNewAiConversation(); loadAiHistory(); } catch (error) { showModal('⚠️', 'Could not delete', error.message); } } });
      row.append(button, remove); container.append(row);
    });
  } catch (error) { container.replaceChildren(makeNotice(error.message)); }
}
async function selectAiConversation(item) {
  try {
    const messages = await jsonRequest(`/api/ai/conversations/${encodeURIComponent(item.id)}/messages`);
    currentAiConversationId = item.id; currentAiConversationTitle = item.title;
    document.getElementById('ai-provider').value = item.provider;
    renderAiMessages(messages);
    loadAiHistory();
  } catch (error) { showModal('⚠️', 'History could not open', error.message); }
}
function renderAiMessages(messages) {
  const logs = document.getElementById('ai-logs'); logs.replaceChildren();
  if (!messages.length) return logs.append(makeWelcome());
  messages.forEach(item => addChatMessage(logs, { id: item.id, source: 'ai', userId: item.role === 'user' ? currentUserId : 'assistant', user: item.role === 'user' ? currentUser : 'AI', displayName: item.role === 'user' ? currentProfile?.displayName : 'AI', msg: item.content, status: 'sent' }));
}
function makeWelcome() {
  const card = document.createElement('div'); card.className = 'welcome-card';
  const mascot = document.createElement('span'); mascot.className = 'welcome-mascot'; mascot.textContent = '🧠';
  const title = document.createElement('h3'); title.textContent = 'Ask away!';
  const copy = document.createElement('p'); copy.textContent = 'သင့်ကိုယ်ပိုင် API key နဲ့ AI ကို မေးမြန်းနိုင်ပါတယ်။';
  card.append(mascot, title, copy); return card;
}
async function startNewAiConversation() {
  currentAiConversationId = ''; currentAiConversationTitle = '';
  document.getElementById('ai-logs').replaceChildren(makeWelcome());
  document.getElementById('ai-prompt').focus();
  loadAiHistory();
}
async function sendAiPrompt() {
  const input = document.getElementById('ai-prompt');
  const prompt = input.value.trim();
  if (!prompt) return;
  const logs = document.getElementById('ai-logs');
  if (logs.querySelector('.welcome-card')) logs.replaceChildren();
  const userBubble = addChatMessage(logs, { source: 'ai', userId: currentUserId, user: currentUser, displayName: currentProfile?.displayName || currentUser, msg: prompt, status: 'sent' });
  input.value = '';
  const waiting = makeNotice('Thinking…', 'chat-bubble other typing-indicator'); logs.append(waiting);
  try {
    const provider = document.getElementById('ai-provider').value;
    if (!currentAiConversationId) {
      const created = await jsonRequest('/api/ai/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, title: prompt.slice(0, 80) }) });
      currentAiConversationId = created.id; currentAiConversationTitle = created.title;
    }
    setProgress('ai-send', 0);
    const data = await xhrJsonRequest('/api/ai/chat', {
      method: 'POST', timeout: 180_000, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, prompt, conversationId: currentAiConversationId })
    }, (percent, phase) => setProgress('ai-send', percent, phase));
    setProgress('ai-send', 100);
    setTimeout(() => hideProgress('ai-send'), 900);
    waiting.remove();
    addChatMessage(logs, { source: 'ai', userId: 'assistant', user: 'AI', displayName: 'AI', msg: data.text || '(No response)' });
    loadAiHistory();
  } catch (error) {
    hideProgress('ai-send');
    waiting.remove();
    addChatMessage(logs, { source: 'ai', userId: 'assistant', user: 'AI', displayName: 'AI', msg: error.message });
  }
  userBubble?.scrollIntoView({ block: 'nearest' });
}

function addDownloadLink(container, token, label) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'download-link'; button.textContent = `⬇ ${label}`;
  button.addEventListener('click', () => downloadVideoFile(token)); container.append(button);
}
async function downloadVideo() {
  const url = document.getElementById('dl-url').value.trim();
  const result = document.getElementById('dl-result');
  if (!url) return showModal('⚠️', 'Add a video link', 'TikTok, YouTube သို့မဟုတ် Facebook link ထည့်ပါ။');
  result.replaceChildren();
  showModal('🛠️', 'Preparing your link', 'Downloader instance ကို ချိတ်ဆက်နေပါသည်…');
  try {
    const data = await jsonRequest('/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    closeModal();
    if (!data.downloads?.length) throw new Error('Download link မရပါ။');
    if (data.filename) { const filename = document.createElement('p'); filename.className = 'filename-label'; filename.textContent = data.filename; result.append(filename); }
    data.downloads.forEach(item => addDownloadLink(result, item.token, item.label));
  } catch (error) { closeModal(); result.append(makeNotice(error.message)); }
}
function downloadVideoFile(token) {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', `/api/download/file/${encodeURIComponent(token)}`);
  xhr.withCredentials = true; xhr.responseType = 'blob';
  const result = document.getElementById('dl-result');
  setProgress('download', 0);
  xhr.onprogress = event => {
    if (event.lengthComputable && event.total > 0) setProgress('download', Math.round(event.loaded / event.total * 100));
    else setProgress('download', null, `${(event.loaded / (1024 * 1024)).toFixed(1)} MB downloaded · size unknown`);
  };
  xhr.onload = () => {
    if (xhr.status < 200 || xhr.status >= 300) {
      hideProgress('download');
      const reader = new FileReader(); reader.onload = () => { try { const body = JSON.parse(reader.result); result.append(makeNotice(body.error || `Download failed (${xhr.status})`)); } catch { result.append(makeNotice(`Download failed (${xhr.status})`)); } }; reader.readAsText(xhr.response); return;
    }
    setProgress('download', 100);
    const disposition = xhr.getResponseHeader('Content-Disposition') || '';
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const filename = encodedName ? decodeURIComponent(encodedName) : 'video.mp4';
    const objectUrl = URL.createObjectURL(xhr.response);
    const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  };
  xhr.onerror = () => { hideProgress('download'); result.append(makeNotice('Download မအောင်မြင်ပါ။ Network ကိုစစ်ပါ။')); };
  xhr.send();
}
function selectedMusicFile() {
  const file = document.getElementById('music-file').files[0];
  document.getElementById('selected-file').textContent = file ? `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB` : 'No file chosen';
}
function uploadMusic() {
  const input = document.getElementById('music-file');
  const file = input.files[0];
  if (!file) return showModal('🎵', 'Choose a song', 'တင်လိုတဲ့ audio ဖိုင်ကို အရင်ရွေးပါ။');
  if (file.size > 25 * 1024 * 1024) return showModal('📦', 'File is too large', 'ဖိုင်အရွယ်အစား 25 MB ထက်မကျော်ရပါ။');
  const formData = new FormData(); formData.append('audio', file); formData.append('folder', document.getElementById('folder-name').value.trim() || 'General');
  const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/music/upload', true); xhr.withCredentials = true;
  setProgress('music-upload', 0);
  xhr.upload.onprogress = event => { if (event.lengthComputable) setProgress('music-upload', Math.round(event.loaded / event.total * 100)); };
  xhr.upload.onload = () => setProgress('music-upload', null, 'Saving to library');
  xhr.timeout = 180_000;
  xhr.onload = () => {
    let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* invalid response */ }
    if (xhr.status >= 200 && xhr.status < 300 && data.success) { setProgress('music-upload', 100); input.value = ''; selectedMusicFile(); loadMusic(); showModal('🎉', 'Song uploaded!', 'သီချင်းကို Public Music ထဲ ထည့်ပြီးပါပြီ။'); }
    else { hideProgress('music-upload'); showModal('😿', 'Upload did not finish', data.error || `Upload failed (${xhr.status || 'network error'})`); }
  };
  xhr.onerror = () => { hideProgress('music-upload'); showModal('😿', 'Upload failed', 'Network သို့မဟုတ် server ကို စစ်ဆေးပြီး ထပ်ကြိုးစားပါ။'); };
  xhr.ontimeout = () => { hideProgress('music-upload'); showModal('😿', 'Upload timed out', 'Server တုံ့ပြန်မှု အချိန်ကျော်သွားပါသည်။'); };
  xhr.send(formData);
}
async function loadMusic() {
  const container = document.getElementById('music-list');
  try {
    const list = await jsonRequest('/api/music/list'); container.replaceChildren();
    if (!list.length) return container.append(makeNotice('ဒီ jukebox ထဲမှာ သီချင်းမရှိသေးပါ။'));
    list.forEach(song => {
      const card = document.createElement('article'); card.className = 'music-card cartoon-card';
      const heading = document.createElement('div'); heading.className = 'music-header';
      const details = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = `📂 ${song.folder || 'General'} · ${song.title}`;
      const uploader = document.createElement('small'); uploader.textContent = `Uploaded by ${song.uploaderName || song.uploader}`;
      details.append(title, uploader); heading.append(details);
      if (song.uploader_id === currentUserId || song.uploader === currentUser) {
        const remove = document.createElement('button'); remove.className = 'delete-btn'; remove.type = 'button'; remove.textContent = 'Delete'; remove.addEventListener('click', () => deleteMusic(song.id)); heading.append(remove);
      }
      const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none';
      if (typeof song.file_url === 'string') {
        try { const source = new URL(song.file_url, window.location.origin); if ((source.origin === window.location.origin && source.pathname.startsWith('/uploads/')) || source.protocol === 'https:') audio.src = source.href; } catch { /* ignore malformed URL */ }
      }
      card.append(heading, audio); container.append(card);
    });
  } catch (error) { container.replaceChildren(makeNotice(error.message)); }
}
async function deleteMusic(id) {
  if (!confirm('ဒီသီချင်းကို ဖျက်မှာ သေချာပါသလား?')) return;
  try { await jsonRequest(`/api/music/delete/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadMusic(); }
  catch (error) { showModal('😿', 'Could not delete', error.message); }
}

async function loadProfile() {
  try {
    const data = await jsonRequest('/api/profile'); currentProfile = data.profile;
    document.getElementById('profile-name').value = data.profile.displayName || '';
    document.getElementById('profile-username').value = data.profile.username || '';
    document.getElementById('profile-avatar-preview').src = data.profile.avatarUrl || 'logo.png';
  } catch (error) { showModal('⚠️', 'Profile unavailable', error.message); }
}
async function updateProfile() {
  const displayNameValue = document.getElementById('profile-name').value.trim();
  const username = document.getElementById('profile-username').value.trim().toLowerCase();
  try {
    const data = await jsonRequest('/api/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: displayNameValue, username }) });
    currentProfile = data.profile; currentUser = data.profile.username; document.getElementById('profile-username').value = currentUser;
    showModal('✅', 'Profile saved', 'Account Name နဲ့ Username ကို ပြောင်းပြီးပါပြီ။');
    loadUsers(); loadConversations();
  } catch (error) { showModal('⚠️', 'Could not update profile', error.message); }
}
function uploadProfilePhoto() {
  const input = document.getElementById('profile-photo-file'); const file = input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) return showModal('📦', 'Photo too large', 'Profile ပုံအရွယ်အစား 5 MB ထက်မကျော်ရပါ။');
  const form = new FormData(); form.append('photo', file);
  const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/profile/photo'); xhr.withCredentials = true;
  setProgress('profile-photo', 0);
  xhr.upload.onprogress = event => { if (event.lengthComputable) setProgress('profile-photo', Math.round(event.loaded / event.total * 100)); };
  xhr.upload.onload = () => setProgress('profile-photo', null, 'Saving photo');
  xhr.timeout = 30_000;
  xhr.onload = () => {
    let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
    if (xhr.status >= 200 && xhr.status < 300) { currentProfile = data.profile; document.getElementById('profile-avatar-preview').src = data.profile.avatarUrl; setProgress('profile-photo', 100); }
    else { hideProgress('profile-photo'); showModal('⚠️', 'Photo upload failed', data.error || `Upload failed (${xhr.status})`); }
  };
  xhr.onerror = () => { hideProgress('profile-photo'); showModal('⚠️', 'Photo upload failed', 'Network ကိုစစ်ဆေးပါ။'); };
  xhr.ontimeout = () => { hideProgress('profile-photo'); showModal('⚠️', 'Photo upload timed out', 'Server တုံ့ပြန်မှု အချိန်ကျော်သွားပါသည်။'); };
  xhr.send(form);
}
async function changePassword() {
  const currentPassword = document.getElementById('current-password').value;
  const newPassword = document.getElementById('new-password').value;
  const confirmPassword = document.getElementById('confirm-new-password').value;
  if (newPassword !== confirmPassword) return showModal('⚠️', 'Password မတူပါ', 'Password အသစ်နှစ်ခုကို တူညီအောင်ထည့်ပါ။');
  try {
    const data = await jsonRequest('/api/profile/password', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword, newPassword }) });
    ['current-password', 'new-password', 'confirm-new-password'].forEach(id => { document.getElementById(id).value = ''; });
    showModal('✅', 'Password changed', data.message);
  } catch (error) { showModal('⚠️', 'Could not change password', error.message); }
}
async function refreshKeyStatus() {
  const providers = ['gemini', 'groq', 'deepseek', 'openai', 'xai', 'manus'];
  try {
    const data = await jsonRequest('/api/settings');
    providers.forEach(provider => { const status = document.getElementById(`${provider}-key-status`); if (status) status.textContent = data[`${provider}Configured`] ? 'Saved for your account' : 'Not saved'; });
  } catch (error) { showModal('⚠️', 'Settings unavailable', error.message); }
}
async function saveSettings(provider) {
  const input = document.getElementById(`${provider}-key`); const key = input.value.trim();
  if (!key) return showModal('🔑', 'Add a key first', 'သိမ်းလိုတဲ့ API key ကို ဖြည့်ပါ။');
  try {
    const data = await jsonRequest('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [`${provider}Key`]: key }) });
    input.value = ''; await refreshKeyStatus(); showModal('🔐', 'Saved privately', data.message);
  } catch (error) { showModal('😿', 'Could not save key', error.message); }
}
async function clearApiKey(provider) {
  if (!confirm(`${provider} API key ကို သင့် account မှ ဖယ်ရှားမှာ သေချာပါသလား?`)) return;
  try {
    await jsonRequest('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [`clear${provider[0].toUpperCase()}${provider.slice(1)}`]: true }) });
    await refreshKeyStatus(); showModal('🧹', 'Key removed', `${provider} key ကို ဖယ်ရှားပြီးပါပြီ။`);
  } catch (error) { showModal('😿', 'Could not remove key', error.message); }
}
function enterApp(username, userId) {
  currentUser = username || ''; currentUserId = userId || '';
  document.getElementById('auth-container').style.display = 'none';
  const app = document.getElementById('app-container'); app.style.display = 'flex'; app.classList.add('sidebar-closed');
  navigationHistory = []; activeTab = 'ai-chat'; activateTab('ai-chat');
  loadProfile(); loadUsers(); loadConversations(); loadMusic(); loadAiHistory(); refreshKeyStatus();
  if (!socket.connected) socket.connect();
}
async function restoreSession() {
  try { const data = await jsonRequest('/api/me'); if (data.loggedIn && data.username) enterApp(data.username, data.userId); }
  catch (error) { console.warn('Session restore failed:', error.message); }
}
async function logout() {
  try {
    await jsonRequest('/api/logout', { method: 'POST' });
    socket.disconnect(); currentUser = ''; currentUserId = ''; currentProfile = null; targetUser = ''; targetProfile = null; activePrivateRoom = ''; currentAiConversationId = '';
    document.getElementById('app-container').style.display = 'none';
    document.getElementById('auth-container').style.display = 'flex';
    document.getElementById('auth-pass').value = ''; document.getElementById('auth-user').value = '';
    showModal('👋', 'See you soon!', 'အကောင့်မှ ထွက်ပြီးပါပြီ။');
  } catch (error) { showModal('😿', 'Logout failed', error.message); }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('#ai-prompt, #private-msg, #group-msg').forEach(input => input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (input.id === 'ai-prompt') sendAiPrompt(); if (input.id === 'private-msg') sendPrivateMsg(); if (input.id === 'group-msg') sendGroupMsg(); }
  }));
  document.getElementById('music-file').addEventListener('change', selectedMusicFile);
  document.getElementById('profile-photo-file').addEventListener('change', uploadProfilePhoto);
  document.getElementById('auth-user').addEventListener('input', event => { event.target.value = event.target.value.toLowerCase(); });
  document.getElementById('profile-username').addEventListener('input', event => { event.target.value = event.target.value.toLowerCase(); });
  document.getElementById('auth-pass').addEventListener('keydown', event => { if (event.key === 'Enter') login(); });
  restoreSession();
});
