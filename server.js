require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { GoogleGenAI } = require('@google/genai');
const Groq = require('groq-sdk');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    if (!origin) return callback(null, true);
    try {
      const originHost = new URL(origin).host.toLowerCase();
      const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
      callback(null, originHost === forwardedHost);
    } catch { callback(null, false); }
  }
});
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
const SESSION_SECRET = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'local-development-only-session-secret');
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

if (!SESSION_SECRET) throw new Error('SESSION_SECRET must be configured in production.');
if (process.env.NODE_ENV === 'production' && !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY must be configured in production.');
if (process.env.NODE_ENV === 'production' && !process.env.SUPABASE_URL) throw new Error('SUPABASE_URL must be configured in production.');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zghlmevmxgonupbiszok.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpnaGxtZXZteGdvbnVwYmlzem9rIiwiaWF0IjoxNzkxOTY1NjIyLCJleHAiOjIxMDc1NDE2MjJ9.LEMRj1OA5d_1U2y1zpveLD_cTxQdxw3eEjidKbAXWBc';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

class SupabaseSessionStore extends session.Store {
  get(sid, callback) {
    supabase.from('app_sessions').select('sess,expire').eq('sid', sid).maybeSingle().then(async ({ data, error }) => {
      if (error) throw error;
      if (!data) return callback(null, null);
      if (new Date(data.expire).getTime() <= Date.now()) {
        await supabase.from('app_sessions').delete().eq('sid', sid);
        return callback(null, null);
      }
      callback(null, typeof data.sess === 'string' ? JSON.parse(data.sess) : data.sess);
    }).catch(callback);
  }
  set(sid, sess, callback = () => {}) {
    const expire = new Date(Date.now() + (sess.cookie?.maxAge || SESSION_TTL_MS)).toISOString();
    supabase.from('app_sessions').upsert({ sid, sess, user_id: sess.userId || null, expire }, { onConflict: 'sid' }).then(({ error }) => callback(error || undefined)).catch(callback);
  }
  touch(sid, sess, callback = () => {}) {
    const expire = new Date(Date.now() + (sess.cookie?.maxAge || SESSION_TTL_MS)).toISOString();
    supabase.from('app_sessions').update({ expire, user_id: sess.userId || null }).eq('sid', sid).then(({ error }) => callback(error || undefined)).catch(callback);
  }
  destroy(sid, callback = () => {}) {
    supabase.from('app_sessions').delete().eq('sid', sid).then(({ error }) => callback(error || undefined)).catch(callback);
  }
}

const sessionMiddleware = session({
  store: new SupabaseSessionStore(),
  name: 'flashpro.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS
  }
});
app.use(sessionMiddleware);
io.engine.use((req, res, next) => sessionMiddleware(req, res, next));
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    try {
      const expectedHost = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim().toLowerCase();
      if (new URL(origin).host.toLowerCase() !== expectedHost) return jsonError(res, 403, 'Cross-site request ကို ပိတ်ထားပါသည်။');
    } catch { return jsonError(res, 403, 'Request origin မမှန်ပါ။'); }
  } else if (req.get('sec-fetch-site') === 'cross-site') return jsonError(res, 403, 'Cross-site request ကို ပိတ်ထားပါသည်။');
  next();
});
app.use(express.static(PUBLIC_DIR));

const onlineSockets = new Map();
const loginAttempts = new Map();
async function revokeUserSessions(userId, exceptSessionId = null) {
  let query = supabase.from('app_sessions').delete().eq('user_id', userId);
  if (exceptSessionId) query = query.neq('sid', exceptSessionId);
  const { error } = await query;
  if (error) throw error;
  for (const socketId of onlineSockets.get(userId) || []) {
    const activeSocket = io.sockets.sockets.get(socketId);
    if (!exceptSessionId || activeSocket?.request.sessionID !== exceptSessionId) activeSocket?.disconnect(true);
  }
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
function jsonError(res, status, message) { return res.status(status).json({ success: false, error: message }); }
function userById(id) { return supabase.from('users').select('id,username,display_name,avatar_url,last_seen_at,password,recovery_secret_hash').eq('id', id).maybeSingle(); }
function publicProfile(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    avatarUrl: user.avatar_url || '',
    lastSeenAt: user.last_seen_at || null,
    online: Boolean(onlineSockets.get(user.id)?.size)
  };
}
function rateLimit({ windowMs = 60_000, max = 12, key = req => req.ip || 'unknown' } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = key(req);
    const entry = loginAttempts.get(bucketKey);
    if (!entry || entry.until <= now) {
      loginAttempts.set(bucketKey, { count: 1, until: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) return jsonError(res, 429, 'ခဏနားပြီးမှ ထပ်ကြိုးစားပါ။');
    next();
  };
}
function validUsername(value) { return typeof value === 'string' && /^[a-z0-9_.-]{3,24}$/.test(value); }
function validPassword(value) { return typeof value === 'string' && value.length >= 6 && value.length <= 8; }
function validRecoverySecret(value) { return typeof value === 'string' && value.trim().length >= 4 && value.trim().length <= 128; }
function sessionPromise(req, method) {
  return new Promise((resolve, reject) => req.session[method](err => err ? reject(err) : resolve()));
}
async function requireAuth(req, res, next) {
  try {
    const storedId = req.session?.userId;
    let user = null;
    if (storedId) {
      const result = await userById(storedId);
      if (result.error) throw result.error;
      user = result.data;
    } else if (req.session?.username || req.session?.user) {
      const legacyName = req.session.username || req.session.user;
      const result = await supabase.from('users').select('id,username,display_name,avatar_url,last_seen_at,password,recovery_secret_hash').eq('username', legacyName).maybeSingle();
      if (result.error) throw result.error;
      user = result.data;
      if (user) { req.session.userId = user.id; req.session.username = user.username; await sessionPromise(req, 'save'); }
    }
    if (!user) return jsonError(res, 401, 'ကျေးဇူးပြု၍ အကောင့်ဝင်ပါ။');
    req.user = user;
    if (req.session.username !== user.username) req.session.username = user.username;
    next();
  } catch (error) { next(error); }
}
function validRoomId(room) { return typeof room === 'string' && (room === 'group:global' || /^private:[a-f0-9]{64}$/.test(room)); }
function getConversationRoom(userIdA, userIdB) {
  const pair = [userIdA, userIdB].sort();
  const digest = crypto.createHash('sha256').update(pair.join(':')).digest('hex');
  return `private:${digest}`;
}
async function isConversationMember(conversationId, userId) {
  const { data, error } = await supabase.from('chat_conversation_members').select('user_id').eq('conversation_id', conversationId).eq('user_id', userId).eq('is_deleted', false).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
async function ensureGroupMembership(userId) {
  const { error: convoError } = await supabase.from('chat_conversations').upsert({ id: 'group:global', type: 'group' }, { onConflict: 'id', ignoreDuplicates: true });
  if (convoError) throw convoError;
  const { error } = await supabase.from('chat_conversation_members').upsert({ conversation_id: 'group:global', user_id: userId }, { onConflict: 'conversation_id,user_id', ignoreDuplicates: true });
  if (error) throw error;
}
async function ensurePrivateConversation(userA, userB) {
  const conversationId = getConversationRoom(userA.id, userB.id);
  const { error: conversationError } = await supabase.from('chat_conversations').upsert({ id: conversationId, type: 'private' }, { onConflict: 'id', ignoreDuplicates: true });
  if (conversationError) throw conversationError;
  const members = [userA.id, userB.id].map(user_id => ({ conversation_id: conversationId, user_id }));
  const { error } = await supabase.from('chat_conversation_members').upsert(members, { onConflict: 'conversation_id,user_id', ignoreDuplicates: true });
  if (error) throw error;
  const { error: reopenError } = await supabase.from('chat_conversation_members').update({ is_deleted: false, updated_at: new Date().toISOString() })
    .eq('conversation_id', conversationId).eq('user_id', userA.id);
  if (reopenError) throw reopenError;
  return conversationId;
}
async function getMessageStatuses(messageIds) {
  if (!messageIds.length) return new Map();
  const { data, error } = await supabase.from('chat_message_receipts').select('message_id,status').in('message_id', messageIds);
  if (error) throw error;
  const grouped = new Map();
  for (const row of data || []) {
    if (!grouped.has(row.message_id)) grouped.set(row.message_id, []);
    grouped.get(row.message_id).push(row.status);
  }
  const result = new Map();
  for (const id of messageIds) {
    const statuses = grouped.get(id) || [];
    result.set(id, statuses.length && statuses.every(value => value === 'seen') ? 'seen' : statuses.includes('delivered') || statuses.includes('seen') ? 'delivered' : 'sent');
  }
  return result;
}
async function formatMessages(rows) {
  const senderIds = [...new Set((rows || []).map(row => row.sender_id))];
  const profilesResult = senderIds.length ? await supabase.from('users').select('id,username,display_name,avatar_url').in('id', senderIds) : { data: [], error: null };
  if (profilesResult.error) throw profilesResult.error;
  const profiles = new Map((profilesResult.data || []).map(user => [user.id, user]));
  const statusMap = await getMessageStatuses((rows || []).map(row => row.id));
  return (rows || []).map(row => {
    const profile = profiles.get(row.sender_id) || {};
    return {
      id: row.id,
      room: row.conversation_id,
      userId: row.sender_id,
      user: profile.username || 'Unknown',
      displayName: profile.display_name || profile.username || 'Unknown',
      avatarUrl: profile.avatar_url || '',
      msg: row.is_deleted ? 'This message was deleted' : row.content,
      replyTo: row.reply_to,
      edited: Boolean(row.edited_at),
      deleted: Boolean(row.is_deleted),
      pinned: Boolean(row.is_pinned),
      status: statusMap.get(row.id) || 'sent',
      sentAt: row.created_at
    };
  });
}
function raiseOnError(result) { if (result.error) throw result.error; return result.data; }

app.get('/api/me', asyncRoute(async (req, res) => {
  if (!req.session?.userId && (req.session?.username || req.session?.user)) {
    const legacyName = String(req.session.username || req.session.user).trim().toLowerCase();
    const { data: user, error } = await supabase.from('users').select('id,username').eq('username', legacyName).maybeSingle();
    if (error) throw error;
    if (user) {
      req.session.userId = user.id;
      req.session.username = user.username;
      await sessionPromise(req, 'save');
    }
  }
  res.json(req.session?.userId ? { loggedIn: true, username: req.session.username || '', userId: req.session.userId } : { loggedIn: false });
}));
app.post('/api/logout', asyncRoute(async (req, res) => {
  const userId = req.session?.userId;
  if (userId) {
    const sockets = [...(onlineSockets.get(userId) || [])];
    sockets.forEach(id => {
      const activeSocket = io.sockets.sockets.get(id);
      if (activeSocket?.request.sessionID === req.sessionID) activeSocket.disconnect(true);
    });
  }
  await new Promise((resolve, reject) => req.session.destroy(err => err ? reject(err) : resolve()));
  res.clearCookie('flashpro.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  res.json({ success: true });
}));

app.post('/api/register', rateLimit({ windowMs: 60_000, max: 8 }), asyncRoute(async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const displayName = String(req.body?.displayName || username).trim().slice(0, 48);
  const password = String(req.body?.password || '');
  const recoverySecret = String(req.body?.recoverySecret || '').trim();
  if (!validUsername(username)) return jsonError(res, 400, 'Username ကို စာလုံးအသေး၊ ဂဏန်း၊ underscore၊ dot၊ hyphen ၃ မှ ၂၄ လုံးအတွင်း ထည့်ပါ။');
  if (!validPassword(password)) return jsonError(res, 400, 'Password ကို ၆ လုံးမှ ၈ လုံးအတွင်း ထည့်ပါ။');
  if (!validRecoverySecret(recoverySecret)) return jsonError(res, 400, 'Recovery code/name ကို အနည်းဆုံး ၄ လုံး ထည့်ပါ။');
  const [hashedPassword, recoveryHash] = await Promise.all([bcrypt.hash(password, 12), bcrypt.hash(recoverySecret, 12)]);
  const { data: user, error } = await supabase.from('users').insert({
    username, password: hashedPassword, display_name: displayName || username, recovery_secret_hash: recoveryHash
  }).select('id,username,display_name,avatar_url,last_seen_at').single();
  if (error) {
    if (error.code === '23505') return jsonError(res, 409, 'ဤ username ကို အသုံးပြုထားပြီးပါပြီ။ အခြား username သုံးပါ။');
    console.error('Registration database insert failed:', { code: error.code, message: error.message });
    return jsonError(res, 503, 'Account ဖန်တီးမရပါ။ Supabase schema နှင့် server configuration ကိုစစ်ဆေးပါ။');
  }
  try { await ensureGroupMembership(user.id); }
  catch (error) { console.error('Group membership setup failed:', error.message); }
  await sessionPromise(req, 'regenerate');
  req.session.userId = user.id;
  req.session.username = user.username;
  await sessionPromise(req, 'save');
  res.json({ success: true, username: user.username, message: 'Account ဖန်တီးပြီး အလိုအလျောက် ဝင်ထားပါပြီ။' });
}));

app.post('/api/login', rateLimit({ windowMs: 60_000, max: 12 }), asyncRoute(async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!validUsername(username) || !password) return jsonError(res, 400, 'Username နဲ့ password မှန်ကန်စွာ ဖြည့်ပါ။');
  const { data: user, error } = await supabase.from('users')
    .select('id,username,display_name,avatar_url,last_seen_at,password,recovery_secret_hash')
    .eq('username', username).maybeSingle();
  if (error) throw error;
  if (!user || !await bcrypt.compare(password, user.password)) return jsonError(res, 401, 'Username သို့မဟုတ် Password မှားယွင်းနေပါသည်။');
  await sessionPromise(req, 'regenerate');
  req.session.userId = user.id;
  req.session.username = user.username;
  await sessionPromise(req, 'save');
  await ensureGroupMembership(user.id).catch(error => console.error('Group membership setup failed:', error.message));
  res.json({ success: true, username: user.username, userId: user.id });
}));

app.post('/api/password/recovery/verify', rateLimit({ windowMs: 15 * 60_000, max: 8 }), asyncRoute(async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const secret = String(req.body?.recoverySecret || '').trim();
  if (!validUsername(username) || !secret) return jsonError(res, 400, 'Username နှင့် recovery code/name ကို ဖြည့်ပါ။');
  const { data: user, error } = await supabase.from('users').select('id,recovery_secret_hash').eq('username', username).maybeSingle();
  if (error) throw error;
  if (!user?.recovery_secret_hash || !await bcrypt.compare(secret, user.recovery_secret_hash)) return jsonError(res, 401, 'Username သို့မဟုတ် recovery code/name မကိုက်ညီပါ။');
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const { error: cleanupError } = await supabase.from('password_recovery_tickets').delete().lt('expires_at', now.toISOString());
  if (cleanupError) throw cleanupError;
  const { error: ticketError } = await supabase.from('password_recovery_tickets').insert({
    token_hash: crypto.createHash('sha256').update(token).digest('hex'),
    user_id: user.id, expires_at: new Date(Date.now() + 10 * 60_000).toISOString()
  });
  if (ticketError) throw ticketError;
  res.json({ success: true, resetToken: token, message: 'Recovery အတည်ပြုပြီးပါပြီ။ Password အသစ်ကို သတ်မှတ်ပါ။' });
}));
app.post('/api/password/recovery/reset', rateLimit({ windowMs: 15 * 60_000, max: 8 }), asyncRoute(async (req, res) => {
  const token = String(req.body?.resetToken || '');
  const password = String(req.body?.newPassword || '');
  if (!validPassword(password)) return jsonError(res, 400, 'Password အသစ်ကို ၆ လုံးမှ ၈ လုံးအတွင်း ထည့်ပါ။');
  if (!/^[A-Za-z0-9_-]{32,80}$/.test(token)) return jsonError(res, 401, 'Recovery အတည်ပြုချက် သက်တမ်းကုန်သွားပါပြီ။ ပြန်လည်စစ်ဆေးပါ။');
  const hash = await bcrypt.hash(password, 12);
  const { data, error } = await supabase.rpc('flash_reset_password', {
    p_token_hash: crypto.createHash('sha256').update(token).digest('hex'), p_password_hash: hash
  });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.user_id) return jsonError(res, 401, 'Recovery အတည်ပြုချက် သက်တမ်းကုန်သွားပါပြီ။ ပြန်လည်စစ်ဆေးပါ။');
  await revokeUserSessions(result.user_id);
  res.json({ success: true, message: 'Password အသစ်ကို သိမ်းပြီးပါပြီ။ ပြန်ဝင်နိုင်ပါပြီ။' });
}));

app.get('/api/profile', requireAuth, (req, res) => res.json({ success: true, profile: publicProfile(req.user), recoveryConfigured: Boolean(req.user.recovery_secret_hash) }));
app.patch('/api/profile', requireAuth, asyncRoute(async (req, res) => {
  let displayName = req.user.display_name || req.user.username;
  let username = req.user.username;
  if (typeof req.body?.displayName === 'string') {
    const name = req.body.displayName.trim();
    if (!name || name.length > 48) return jsonError(res, 400, 'Account Name ကို ၁ မှ ၄၈ လုံးအတွင်း ထည့်ပါ။');
    displayName = name;
  }
  if (typeof req.body?.username === 'string') {
    username = req.body.username.trim();
    if (!validUsername(username)) return jsonError(res, 400, 'Username ကို စာလုံးအသေး၊ ဂဏန်း၊ underscore၊ dot၊ hyphen ၃ မှ ၂၄ လုံးအတွင်း ထည့်ပါ။');
    const { data: collision, error: collisionError } = await supabase.from('users').select('id').eq('username', username).neq('id', req.user.id).maybeSingle();
    if (collisionError) throw collisionError;
    if (collision) return jsonError(res, 409, 'ဤ username ကို အသုံးပြုထားပြီးပါပြီ။');
  }
  if (username === req.user.username && displayName === (req.user.display_name || req.user.username)) return jsonError(res, 400, 'ပြောင်းရန် အချက်အလက်အသစ် ထည့်ပါ။');
  const { data, error } = await supabase.rpc('flash_update_profile', { p_user_id: req.user.id, p_new_username: username, p_display_name: displayName });
  if (error?.code === '23505') return jsonError(res, 409, 'ဤ username ကို အသုံးပြုထားပြီးပါပြီ။');
  if (error) throw error;
  const updated = Array.isArray(data) ? data[0] : data;
  if (!updated) return jsonError(res, 404, 'Account ကို မတွေ့ပါ။');
  req.session.username = updated.username;
  await sessionPromise(req, 'save');
  io.emit('profile_updated', publicProfile(updated));
  res.json({ success: true, profile: publicProfile(updated) });
}));
app.patch('/api/profile/password', requireAuth, asyncRoute(async (req, res) => {
  const oldPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (!await bcrypt.compare(oldPassword, req.user.password)) return jsonError(res, 401, 'လက်ရှိ password မမှန်ပါ။');
  if (!validPassword(newPassword)) return jsonError(res, 400, 'Password အသစ်ကို ၆ လုံးမှ ၈ လုံးအတွင်း ထည့်ပါ။');
  const hash = await bcrypt.hash(newPassword, 12);
  const { error } = await supabase.from('users').update({ password: hash }).eq('id', req.user.id);
  if (error) throw error;
  await revokeUserSessions(req.user.id, req.sessionID);
  res.json({ success: true, message: 'Password ပြောင်းပြီးပါပြီ။' });
}));
app.put('/api/profile/recovery-secret', requireAuth, asyncRoute(async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const recoverySecret = String(req.body?.recoverySecret || '').trim();
  if (!await bcrypt.compare(currentPassword, req.user.password)) return jsonError(res, 401, 'လက်ရှိ password မမှန်ပါ။');
  if (!validRecoverySecret(recoverySecret)) return jsonError(res, 400, 'Recovery code/name ကို အနည်းဆုံး ၄ လုံး ထည့်ပါ။');
  const recoveryHash = await bcrypt.hash(recoverySecret, 12);
  const { error } = await supabase.from('users').update({ recovery_secret_hash: recoveryHash }).eq('id', req.user.id);
  if (error) throw error;
  res.json({ success: true, message: 'Recovery code/name ကို လုံခြုံစွာ သိမ်းပြီးပါပြီ။' });
}));

const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, cb) => {
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  if (!allowed.has(file.mimetype)) return cb(new Error('JPG, PNG, WEBP သို့မဟုတ် GIF ပုံကိုသာ တင်နိုင်ပါသည်။'));
  cb(null, true);
} });
app.post('/api/profile/photo', requireAuth, imageUpload.single('photo'), asyncRoute(async (req, res) => {
  if (!req.file) return jsonError(res, 400, 'Profile ပုံကို ရွေးပါ။');
  if (process.env.NODE_ENV === 'production' && !STORAGE_BUCKET) return jsonError(res, 503, 'Production တွင် profile ပုံကို မပျောက်စေရန် SUPABASE_STORAGE_BUCKET ကို သတ်မှတ်ပါ။');
  const extension = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' })[req.file.mimetype];
  const filename = `profile-${req.user.id}-${crypto.randomBytes(6).toString('hex')}${extension}`;
  let avatarUrl;
  if (STORAGE_BUCKET) {
    const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
    if (error) throw error;
    avatarUrl = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(filename).data.publicUrl;
  } else {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    await fs.writeFile(path.join(UPLOAD_DIR, filename), req.file.buffer, { flag: 'wx' });
    avatarUrl = `/uploads/${filename}`;
  }
  const { data: updated, error } = await supabase.from('users').update({ avatar_url: avatarUrl }).eq('id', req.user.id)
    .select('id,username,display_name,avatar_url,last_seen_at').single();
  if (error) throw error;
  io.emit('profile_updated', publicProfile(updated));
  res.json({ success: true, profile: publicProfile(updated) });
}));

app.get('/api/users', requireAuth, asyncRoute(async (req, res) => {
  const { data, error } = await supabase.from('users').select('id,username,display_name,avatar_url,last_seen_at').order('username');
  if (error) throw error;
  res.json((data || []).filter(user => user.id !== req.user.id).map(publicProfile));
}));

const AI_PROVIDERS = ['gemini', 'groq', 'deepseek', 'openai', 'xai', 'manus'];
function settingKey(username, provider) { return `${username}:${provider}_key`; }
function encryptApiKey(value) {
  const key = crypto.createHash('sha256').update(`${SESSION_SECRET}|flash-api-keys`).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}
function decryptApiKey(value) {
  if (typeof value !== 'string') return '';
  if (!value.startsWith('enc:v1:')) return value;
  const [, , ivText, tagText, encryptedText] = value.split(':');
  const key = crypto.createHash('sha256').update(`${SESSION_SECRET}|flash-api-keys`).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
}
async function readSetting(key) {
  const { data, error } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data?.value || '';
}
app.get('/api/settings', requireAuth, asyncRoute(async (req, res) => {
  const keys = AI_PROVIDERS.map(provider => settingKey(req.user.username, provider));
  const { data, error } = await supabase.from('settings').select('key,value').in('key', keys);
  if (error) throw error;
  const saved = new Set((data || []).filter(row => Boolean(row.value)).map(row => row.key));
  res.json(Object.fromEntries(AI_PROVIDERS.map(provider => [`${provider}Configured`, saved.has(settingKey(req.user.username, provider))])));
}));
app.post('/api/settings', requireAuth, asyncRoute(async (req, res) => {
  for (const provider of AI_PROVIDERS) {
    const key = settingKey(req.user.username, provider);
    const clearField = `clear${provider[0].toUpperCase()}${provider.slice(1)}`;
    if (req.body?.[clearField] === true) {
      const { error } = await supabase.from('settings').delete().eq('key', key);
      if (error) throw error;
      if (provider === 'manus') {
        const { data: taskRows, error: taskRowsError } = await supabase.from('settings').select('key').like('key', `${req.user.username}:manus:%:task_id`);
        if (taskRowsError) throw taskRowsError;
        const ownedKeys = (taskRows || []).map(row => row.key).filter(taskKey => taskKey.startsWith(`${req.user.username}:manus:`) && taskKey.endsWith(':task_id'));
        if (ownedKeys.length) {
          const { error: taskDeleteError } = await supabase.from('settings').delete().in('key', ownedKeys);
          if (taskDeleteError) throw taskDeleteError;
        }
      }
      continue;
    }
    const value = req.body?.[`${provider}Key`];
    if (typeof value === 'string' && value.trim()) {
      if (value.trim().length > 1000) return jsonError(res, 400, 'API key အရှည် မမှန်ပါ။');
      const { error } = await supabase.from('settings').upsert({ key, value: encryptApiKey(value.trim()) }, { onConflict: 'key' });
      if (error) throw error;
    }
  }
  res.json({ success: true, message: 'သင့်အကောင့်အတွက် API key များကို လုံခြုံစွာ သိမ်းပြီးပါပြီ။' });
}));

async function callOpenAICompatible({ endpoint, key, model, messages }) {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages }), signal: AbortSignal.timeout(45_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Provider returned HTTP ${response.status}`);
  return data.choices?.[0]?.message?.content || '';
}
async function callManus({ apiKey, username, conversationId, prompt }) {
  const base = 'https://api.manus.ai/v2';
  const headers = { 'Content-Type': 'application/json', 'x-manus-api-key': apiKey };
  const ask = `This is a text-only chat. Reply directly to the user's question. Do not use integrations, connectors, or tools, and do not perform external actions.\n\nUser: ${prompt}`;
  const taskKey = `${username}:manus:${conversationId}:task_id`;
  let taskId = await readSetting(taskKey);
  const requestStartedAt = Date.now();
  if (!taskId) {
    const response = await fetch(`${base}/task.create`, {
      method: 'POST', headers,
      body: JSON.stringify({ message: { content: ask, connectors: [] }, title: 'Flâsh Pro AI chat', share_visibility: 'private', interactive_mode: false, agent_profile: 'standard' }),
      signal: AbortSignal.timeout(20_000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.task_id) throw new Error(data.error?.message || 'Manus API task could not be created.');
    taskId = data.task_id;
    const { error } = await supabase.from('settings').upsert({ key: taskKey, value: taskId }, { onConflict: 'key' });
    if (error) throw new Error('Manus task was created, but its chat session could not be saved.');
  } else {
    const response = await fetch(`${base}/task.sendMessage`, {
      method: 'POST', headers, body: JSON.stringify({ task_id: taskId, message: { content: ask }, clear_connectors: true }),
      signal: AbortSignal.timeout(20_000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || 'Manus API could not continue this chat.');
  }
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const [messagesResponse, detailResponse] = await Promise.all([
      fetch(`${base}/task.listMessages?task_id=${encodeURIComponent(taskId)}&order=desc&limit=20`, { headers, signal: AbortSignal.timeout(15_000) }),
      fetch(`${base}/task.detail?task_id=${encodeURIComponent(taskId)}`, { headers, signal: AbortSignal.timeout(15_000) })
    ]);
    const messagesData = await messagesResponse.json().catch(() => ({}));
    const detailData = await detailResponse.json().catch(() => ({}));
    if (!messagesResponse.ok || !detailResponse.ok) throw new Error('Manus API could not retrieve the chat response.');
    const task = detailData.task || {};
    const recent = (messagesData.messages || []).filter(event => Number(event.timestamp || 0) >= requestStartedAt);
    const answer = recent.find(event => event.type === 'assistant_message' && event.assistant_message?.content)?.assistant_message?.content;
    if (task.status === 'error') throw new Error('Manus Agent reported an error.');
    if (task.status === 'waiting') {
      if (answer) return answer;
      throw new Error('Manus Agent is waiting for input. Open your Manus task to continue this thread.');
    }
    if (task.status === 'stopped' && task.has_running_background_jobs === false) {
      if (answer) return answer;
      throw new Error(recent.find(event => event.type === 'error_message')?.error_message?.content || 'Manus Agent stopped without a text response.');
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error('Manus is still working. Please try again shortly; the task continues in your Manus account.');
}

app.get('/api/ai/conversations', requireAuth, asyncRoute(async (req, res) => {
  const { data, error } = await supabase.from('ai_conversations').select('id,title,provider,created_at,updated_at').eq('user_id', req.user.id).order('updated_at', { ascending: false }).limit(100);
  if (error) throw error;
  res.json(data || []);
}));
app.post('/api/ai/conversations', requireAuth, asyncRoute(async (req, res) => {
  const provider = AI_PROVIDERS.includes(req.body?.provider) ? req.body.provider : 'gemini';
  const title = String(req.body?.title || 'New conversation').trim().slice(0, 80) || 'New conversation';
  const { data, error } = await supabase.from('ai_conversations').insert({ user_id: req.user.id, provider, title }).select('id,title,provider,created_at,updated_at').single();
  if (error) throw error;
  res.status(201).json(data);
}));
app.get('/api/ai/conversations/:id/messages', requireAuth, asyncRoute(async (req, res) => {
  const { data: convo, error: convoError } = await supabase.from('ai_conversations').select('id').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
  if (convoError) throw convoError;
  if (!convo) return jsonError(res, 404, 'AI conversation ကို မတွေ့ပါ။');
  const { data, error } = await supabase.from('ai_messages').select('id,role,content,created_at').eq('conversation_id', convo.id).order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  res.json((data || []).reverse());
}));
app.delete('/api/ai/conversations/:id', requireAuth, asyncRoute(async (req, res) => {
  const { data, error } = await supabase.from('ai_conversations').delete().eq('id', req.params.id).eq('user_id', req.user.id).select('id').maybeSingle();
  if (error) throw error;
  if (!data) return jsonError(res, 404, 'AI conversation ကို မတွေ့ပါ။');
  res.json({ success: true });
}));
app.post('/api/ai/chat', requireAuth, asyncRoute(async (req, res) => {
  const provider = req.body?.provider;
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  const conversationId = String(req.body?.conversationId || '');
  if (!AI_PROVIDERS.includes(provider)) return jsonError(res, 400, 'AI provider ကို ရွေးချယ်ပါ။');
  if (!prompt || prompt.length > 6000) return jsonError(res, 400, 'မေးခွန်းကို ဖြည့်ပါ (အများဆုံး ၆,၀၀၀ စာလုံး)။');
  const { data: conversation, error: conversationError } = await supabase.from('ai_conversations').select('id,title').eq('id', conversationId).eq('user_id', req.user.id).maybeSingle();
  if (conversationError) throw conversationError;
  if (!conversation) return jsonError(res, 404, 'AI conversation မတွေ့ပါ။ History မှ conversation အသစ်ဖွင့်ပါ။');
  const { data: oldMessages, error: historyError } = await supabase.from('ai_messages').select('role,content').eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(100);
  if (historyError) throw historyError;
  let remainingChars = 30_000;
  const history = [];
  for (const item of oldMessages || []) {
    const content = String(item.content || '').slice(-remainingChars);
    history.unshift({ role: item.role, content });
    remainingChars -= content.length;
    if (remainingChars <= 0) break;
  }
  try {
    const storedKey = await readSetting(settingKey(req.user.username, provider));
    if (!storedKey) return jsonError(res, 400, 'Settings ထဲတွင် သင့်ကိုယ်ပိုင် API key ထည့်ပါ။');
    const apiKey = decryptApiKey(storedKey);
    const messages = [...history, { role: 'user', content: prompt }];
    let text = '';
    if (provider === 'gemini') {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash', contents: messages.map(item => ({ role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: item.content }] })) });
      text = response.text || '';
    } else if (provider === 'groq') {
      const groq = new Groq({ apiKey });
      const completion = await groq.chat.completions.create({ messages, model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b' });
      text = completion.choices[0]?.message?.content || '';
    } else if (provider === 'deepseek') {
      text = await callOpenAICompatible({ endpoint: 'https://api.deepseek.com/chat/completions', key: apiKey, model: process.env.DEEPSEEK_MODEL || 'deepseek-flash', messages });
    } else if (provider === 'openai') {
      text = await callOpenAICompatible({ endpoint: 'https://api.openai.com/v1/chat/completions', key: apiKey, model: process.env.OPENAI_MODEL || 'gpt-4.1-mini', messages });
    } else if (provider === 'xai') {
      text = await callOpenAICompatible({ endpoint: 'https://api.x.ai/v1/chat/completions', key: apiKey, model: process.env.XAI_MODEL || 'grok-4.7', messages });
    } else {
      text = await callManus({ apiKey, username: req.user.username, conversationId, prompt });
    }
    const { error: saveError } = await supabase.from('ai_messages').insert([
      { conversation_id: conversationId, role: 'user', content: prompt },
      { conversation_id: conversationId, role: 'assistant', content: text }
    ]);
    if (saveError) throw saveError;
    const { error: updateError } = await supabase.from('ai_conversations').update({
      ...(conversation.title === 'New conversation' ? { title: prompt.slice(0, 80) } : {}),
      provider, updated_at: new Date().toISOString()
    }).eq('id', conversationId);
    if (updateError) throw updateError;
    res.json({ text, conversationId });
  } catch (error) {
    console.error(`${provider} AI request failed:`, error.message);
    res.status(502).json({ error: error.message?.startsWith('Manus') ? error.message : 'AI service ကို ခေါ်ယူ၍မရပါ။ API key၊ model နှင့် provider ကို စစ်ဆေးပါ။' });
  }
}));

const COBALT_API_URL = process.env.COBALT_API_URL;
const COBALT_API_KEY = process.env.COBALT_API_KEY;
function isAllowedVideoUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com') ||
      host === 'tiktok.com' || host.endsWith('.tiktok.com') ||
      host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.watch' || host.endsWith('.fb.watch');
  } catch { return false; }
}
app.post('/api/download', requireAuth, asyncRoute(async (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!isAllowedVideoUrl(url)) return jsonError(res, 400, 'မှန်ကန်သော YouTube, TikTok သို့မဟုတ် public Facebook video link ထည့်ပါ။');
  if (!COBALT_API_URL) return jsonError(res, 503, 'Downloader မသတ်မှတ်ရသေးပါ။ ကိုယ်ပိုင် သို့မဟုတ် ခွင့်ပြုချက်ရ Cobalt instance ကို COBALT_API_URL ဖြင့်သတ်မှတ်ပါ။');
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (COBALT_API_KEY) headers.Authorization = `Api-Key ${COBALT_API_KEY}`;
  try {
    const response = await fetch(COBALT_API_URL, { method: 'POST', headers, body: JSON.stringify({ url, localProcessing: 'disabled' }), signal: AbortSignal.timeout(30_000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return jsonError(res, 502, data?.error?.code ? `Downloader API error: ${data.error.code}` : `Downloader API က HTTP ${response.status} ပြန်ပေးသည်။`);
    if (data.status === 'error') return jsonError(res, 422, data.error?.code || 'ဤ video ကို မရယူနိုင်ပါ။ Facebook တွင် public video များသာ download လုပ်နိုင်သည်။');
    if (data.status === 'local-processing') return jsonError(res, 422, 'ဤ Cobalt instance က server-side processing မပေးနိုင်ပါ။');
    const links = [];
    if (['tunnel', 'redirect'].includes(data.status) && typeof data.url === 'string') links.push(data.url);
    if (data.status === 'picker' && Array.isArray(data.picker)) for (const item of data.picker) if (typeof item.url === 'string') links.push(item.url);
    const validLinks = links.filter(link => { try { return new URL(link).protocol === 'https:'; } catch { return false; } });
    if (!validLinks.length) return jsonError(res, 502, 'Downloader API မှ download link ပြန်မရပါ။');
    const now = new Date();
    const { error: cleanupError } = await supabase.from('download_tickets').delete().lt('expires_at', now.toISOString());
    if (cleanupError) throw cleanupError;
    const ticketRows = validLinks.map((target, index) => {
      const token = crypto.randomBytes(24).toString('base64url');
      return {
        token,
        row: {
          token_hash: crypto.createHash('sha256').update(token).digest('hex'),
          user_id: req.user.id, target,
          filename: data.filename || data.output?.filename || `video-${index + 1}.mp4`,
          expires_at: new Date(Date.now() + 10 * 60_000).toISOString()
        },
        label: validLinks.length > 1 ? `Download ${index + 1}` : 'Download video'
      };
    });
    const { error: ticketError } = await supabase.from('download_tickets').insert(ticketRows.map(item => item.row));
    if (ticketError) throw ticketError;
    const downloads = ticketRows.map(({ token, label }) => ({ token, label }));
    res.json({ success: true, downloads, filename: data.filename || data.output?.filename || '' });
  } catch (error) {
    const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
    jsonError(res, 502, timeout ? 'Downloader တုံ့ပြန်မှု အချိန်ကျော်သွားပါသည်။' : 'Downloader API သို့ ချိတ်ဆက်မရပါ။');
  }
}));
app.get('/api/download/file/:token', requireAuth, asyncRoute(async (req, res) => {
  if (!/^[A-Za-z0-9_-]{24,80}$/.test(req.params.token)) return jsonError(res, 404, 'Download link သက်တမ်းကုန်သွားပါပြီ။ ထပ်မံတောင်းပါ။');
  const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
  const { data, error } = await supabase.rpc('flash_consume_download_ticket', { p_token_hash: tokenHash, p_user_id: req.user.id });
  if (error) throw error;
  const ticket = Array.isArray(data) ? data[0] : data;
  if (!ticket) return jsonError(res, 404, 'Download link သက်တမ်းကုန်သွားပါပြီ။ ထပ်မံတောင်းပါ။');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15 * 60_000);
  try {
    const upstream = await fetch(ticket.target, { signal: controller.signal, redirect: 'follow' });
    if (!upstream.ok || !upstream.body) return jsonError(res, 502, `Video server က HTTP ${upstream.status} ပြန်ပေးသည်။`);
    res.status(200);
    res.setHeader('Content-Type', 'application/octet-stream');
    const safeName = path.basename(String(ticket.filename).replace(/[\r\n"\\]/g, '_')).slice(0, 140) || 'video.mp4';
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`);
    const contentLength = upstream.headers.get('content-length');
    const estimate = upstream.headers.get('estimated-content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (estimate) res.setHeader('X-Download-Estimated-Length', estimate);
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    if (!res.headersSent) jsonError(res, 502, error.name === 'AbortError' ? 'Download အချိန်ကျော်သွားပါသည်။' : 'Video file ကို မရယူနိုင်ပါ။');
    else res.destroy(error);
  } finally { clearTimeout(timeout); }
}));

const allowedAudioExtensions = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.webm']);
const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => { try { await fs.mkdir(UPLOAD_DIR, { recursive: true }); cb(null, UPLOAD_DIR); } catch (error) { cb(error); } },
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage, limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const validMime = file.mimetype.startsWith('audio/') || (extension === '.webm' && file.mimetype === 'video/webm');
    if (!allowedAudioExtensions.has(extension) || !validMime) return cb(new Error('MP3/WAV/OGG/M4A/AAC/FLAC/WebM အသံဖိုင်များကိုသာ တင်နိုင်ပါသည်။'));
    cb(null, true);
  }
});
app.post('/api/music/upload', requireAuth, upload.single('audio'), asyncRoute(async (req, res) => {
  if (!req.file) return jsonError(res, 400, 'အသံဖိုင်ကို ရွေးပါ။');
  if (process.env.NODE_ENV === 'production' && !STORAGE_BUCKET) {
    await fs.unlink(req.file.path).catch(() => {});
    return jsonError(res, 503, 'Production တွင် သီချင်းများကို မပျောက်စေရန် SUPABASE_STORAGE_BUCKET ကို သတ်မှတ်ပါ။');
  }
  const folder = typeof req.body?.folder === 'string' ? req.body.folder.trim().slice(0, 60) : 'General';
  const title = path.basename(req.file.originalname).slice(0, 180);
  let fileUrl = `/uploads/${req.file.filename}`;
  let storedRemotely = false;
  try {
    if (STORAGE_BUCKET) {
      const fileBuffer = await fs.readFile(req.file.path);
      const { error: storageError } = await supabase.storage.from(STORAGE_BUCKET).upload(req.file.filename, fileBuffer, { contentType: req.file.mimetype, upsert: false });
      if (storageError) throw storageError;
      storedRemotely = true;
      fileUrl = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(req.file.filename).data.publicUrl;
    }
    const { error } = await supabase.from('music').insert({ title, file_url: fileUrl, uploader: req.user.username, uploader_id: req.user.id, folder: folder || 'General' });
    if (error) throw error;
    if (storedRemotely) await fs.unlink(req.file.path).catch(() => {});
    res.json({ success: true });
  } catch (error) {
    if (storedRemotely) await supabase.storage.from(STORAGE_BUCKET).remove([req.file.filename]).catch(() => {});
    await fs.unlink(req.file.path).catch(() => {});
    console.error('Music upload failed:', error.message);
    jsonError(res, 503, 'သီချင်းဖိုင် သို့မဟုတ် အချက်အလက်ကို မသိမ်းနိုင်ပါ။ Supabase Storage/Database ကို စစ်ဆေးပါ။');
  }
}));
app.get('/api/music/list', requireAuth, asyncRoute(async (_req, res) => {
  const { data, error } = await supabase.from('music').select('id,title,file_url,uploader,folder,uploader_id').order('id', { ascending: false }).limit(500);
  if (error) throw error;
  const uploaderIds = [...new Set((data || []).map(song => song.uploader_id).filter(Boolean))];
  const profileResult = uploaderIds.length ? await supabase.from('users').select('id,username,display_name').in('id', uploaderIds) : { data: [], error: null };
  if (profileResult.error) throw profileResult.error;
  const profiles = new Map((profileResult.data || []).map(user => [user.id, user]));
  res.json((data || []).map(song => ({ ...song, uploader: profiles.get(song.uploader_id)?.username || song.uploader, uploaderName: profiles.get(song.uploader_id)?.display_name || song.uploader })));
}));
app.delete('/api/music/delete/:id', requireAuth, asyncRoute(async (req, res) => {
  const { data: song, error: findError } = await supabase.from('music').select('id,uploader,uploader_id,file_url').eq('id', req.params.id).maybeSingle();
  if (findError) throw findError;
  if (!song) return jsonError(res, 404, 'သီချင်း မတွေ့ပါ။');
  if (song.uploader_id ? song.uploader_id !== req.user.id : song.uploader !== req.user.username) return jsonError(res, 403, 'ကိုယ်ပိုင်သီချင်းကိုသာ ဖျက်နိုင်ပါသည်။');
  const { error } = await supabase.from('music').delete().eq('id', req.params.id);
  if (error) throw error;
  const basename = path.basename(song.file_url || '');
  if (basename && STORAGE_BUCKET && song.file_url?.startsWith(`${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/`)) await supabase.storage.from(STORAGE_BUCKET).remove([basename]).catch(() => {});
  else if (basename && song.file_url?.startsWith('/uploads/')) await fs.unlink(path.join(UPLOAD_DIR, basename)).catch(() => {});
  res.json({ success: true });
}));

app.post('/api/conversations/private', requireAuth, asyncRoute(async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  if (!validUsername(username)) return jsonError(res, 400, 'Username မမှန်ပါ။');
  const { data: target, error } = await supabase.from('users').select('id,username,display_name,avatar_url,last_seen_at').eq('username', username).maybeSingle();
  if (error) throw error;
  if (!target || target.id === req.user.id) return jsonError(res, 404, 'အသုံးပြုသူကို မတွေ့ပါ။');
  const conversationId = await ensurePrivateConversation(req.user, target);
  res.json({ success: true, conversationId, otherUser: publicProfile(target) });
}));
app.get('/api/conversations', requireAuth, asyncRoute(async (req, res) => {
  const { data: ownMemberships, error: ownError } = await supabase.from('chat_conversation_members')
    .select('conversation_id,nickname,is_pinned,is_deleted,last_read_at,updated_at').eq('user_id', req.user.id).eq('is_deleted', false);
  if (ownError) throw ownError;
  const memberships = ownMemberships || [];
  if (!memberships.length) return res.json([]);
  const ids = memberships.map(row => row.conversation_id);
  const [{ data: conversations, error: conversationError }, { data: allMembers, error: memberError }, { data: messages, error: messageError }] = await Promise.all([
    supabase.from('chat_conversations').select('id,type,updated_at').in('id', ids),
    supabase.from('chat_conversation_members').select('conversation_id,user_id,nickname,is_pinned').in('conversation_id', ids),
    supabase.from('chat_messages').select('id,conversation_id,content,created_at,sender_id,is_deleted').in('conversation_id', ids).order('created_at', { ascending: false }).limit(500)
  ]);
  if (conversationError || memberError || messageError) throw conversationError || memberError || messageError;
  const usersIds = [...new Set((allMembers || []).map(item => item.user_id))];
  const { data: users, error: usersError } = await supabase.from('users').select('id,username,display_name,avatar_url,last_seen_at').in('id', usersIds);
  if (usersError) throw usersError;
  const profileMap = new Map((users || []).map(user => [user.id, publicProfile(user)]));
  const messageMap = new Map();
  for (const message of messages || []) if (!messageMap.has(message.conversation_id)) messageMap.set(message.conversation_id, message);
  const convoMap = new Map((conversations || []).map(item => [item.id, item]));
  const result = memberships.map(membership => {
    const convo = convoMap.get(membership.conversation_id);
    const members = (allMembers || []).filter(item => item.conversation_id === membership.conversation_id);
    const peerId = members.find(item => item.user_id !== req.user.id)?.user_id;
    const peer = profileMap.get(peerId) || null;
    const latest = messageMap.get(membership.conversation_id);
    return {
      id: membership.conversation_id, type: convo?.type || 'private', nickname: membership.nickname || '',
      isPinned: membership.is_pinned, peer: peer ? { ...peer, nickname: membership.nickname || '' } : null,
      lastMessage: latest ? { text: latest.is_deleted ? 'Message deleted' : latest.content, sentAt: latest.created_at } : null,
      updatedAt: latest?.created_at || membership.updated_at
    };
  }).filter(item => item.type === 'group' || item.lastMessage)
    .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(result);
}));
app.patch('/api/conversations/:id', requireAuth, asyncRoute(async (req, res) => {
  const id = req.params.id;
  if (!validRoomId(id)) return jsonError(res, 400, 'Conversation ID မမှန်ပါ။');
  const updates = { updated_at: new Date().toISOString() };
  if (typeof req.body?.isPinned === 'boolean') updates.is_pinned = req.body.isPinned;
  if (typeof req.body?.isDeleted === 'boolean') updates.is_deleted = req.body.isDeleted;
  if (typeof req.body?.nickname === 'string') updates.nickname = req.body.nickname.trim().slice(0, 40);
  const { data, error } = await supabase.from('chat_conversation_members').update(updates).eq('conversation_id', id).eq('user_id', req.user.id).select('conversation_id').maybeSingle();
  if (error) throw error;
  if (!data) return jsonError(res, 404, 'Conversation ကို မတွေ့ပါ။');
  if (typeof req.body?.isDeleted === 'boolean') {
    for (const socketId of onlineSockets.get(req.user.id) || []) {
      const activeSocket = io.sockets.sockets.get(socketId);
      if (req.body.isDeleted) activeSocket?.leave(id);
      else activeSocket?.join(id);
    }
  }
  res.json({ success: true });
}));
app.post('/api/conversations/:id/messages', rateLimit({ windowMs: 10_000, max: 40, key: req => req.session?.userId || req.ip }), requireAuth, asyncRoute(async (req, res) => {
  const room = req.params.id;
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  const replyTo = typeof req.body?.replyTo === 'string' ? req.body.replyTo : null;
  const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.slice(0, 80) : '';
  if (!validRoomId(room) || !await isConversationMember(room, req.user.id)) return jsonError(res, 404, 'Conversation ကို မတွေ့ပါ။');
  if (!content || content.length > 2000) return jsonError(res, 400, 'Message ကို ၁ မှ ၂၀၀၀ လုံးအတွင်း ထည့်ပါ။');
  if (replyTo) {
    const { data: original, error } = await supabase.from('chat_messages').select('id,conversation_id').eq('id', replyTo).maybeSingle();
    if (error || !original || original.conversation_id !== room) return jsonError(res, 400, 'Reply လုပ်မည့် message မတွေ့ပါ။');
  }
  const { data: row, error } = await supabase.from('chat_messages').insert({ conversation_id: room, sender_id: req.user.id, content, reply_to: replyTo })
    .select('id,conversation_id,sender_id,content,reply_to,is_deleted,is_pinned,edited_at,created_at').single();
  if (error) throw error;
  const { data: members, error: memberError } = await supabase.from('chat_conversation_members').select('user_id').eq('conversation_id', room);
  if (memberError) throw memberError;
  const receipts = (members || []).map(member => ({ message_id: row.id, user_id: member.user_id, status: member.user_id === req.user.id ? 'seen' : 'sent' }));
  const { error: receiptError } = await supabase.from('chat_message_receipts').upsert(receipts, { onConflict: 'message_id,user_id' });
  if (receiptError) throw receiptError;
  const { error: memberUpdateError } = await supabase.from('chat_conversation_members').update({ is_deleted: false, updated_at: new Date().toISOString() }).eq('conversation_id', room);
  if (memberUpdateError) throw memberUpdateError;
  for (const member of members || []) {
    for (const socketId of onlineSockets.get(member.user_id) || []) io.sockets.sockets.get(socketId)?.join(room);
  }
  const activeSocketIds = io.sockets.adapter.rooms.get(room) || new Set();
  const activeUserIds = new Set([...activeSocketIds].map(id => io.sockets.sockets.get(id)?.data.userId).filter(Boolean));
  const deliveredTo = (members || []).map(member => member.user_id).filter(id => id !== req.user.id && activeUserIds.has(id));
  if (deliveredTo.length) {
    const { error: deliveredError } = await supabase.from('chat_message_receipts').update({ status: 'delivered', updated_at: new Date().toISOString() })
      .eq('message_id', row.id).in('user_id', deliveredTo).eq('status', 'sent');
    if (deliveredError) throw deliveredError;
  }
  const { error: conversationUpdateError } = await supabase.from('chat_conversations').update({ updated_at: new Date().toISOString() }).eq('id', room);
  if (conversationUpdateError) throw conversationUpdateError;
  const [message] = await formatMessages([row]);
  message.clientId = clientId;
  io.to(room).emit('receive_message', message);
  res.status(201).json({ success: true, message });
}));
app.get('/api/conversations/:id/messages', requireAuth, asyncRoute(async (req, res) => {
  const id = req.params.id;
  if (!validRoomId(id) || !await isConversationMember(id, req.user.id)) return jsonError(res, 404, 'Conversation ကို မတွေ့ပါ။');
  const { data, error } = await supabase.from('chat_messages').select('id,conversation_id,sender_id,content,reply_to,is_deleted,is_pinned,edited_at,created_at').eq('conversation_id', id).order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  res.json(await formatMessages((data || []).reverse()));
}));
app.patch('/api/messages/:id', requireAuth, asyncRoute(async (req, res) => {
  const { data: message, error } = await supabase.from('chat_messages').select('id,conversation_id,sender_id,is_deleted,is_pinned').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!message || !await isConversationMember(message.conversation_id, req.user.id)) return jsonError(res, 404, 'Message ကို မတွေ့ပါ။');
  const action = req.body?.action;
  const updates = {};
  if (action === 'edit') {
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (message.sender_id !== req.user.id) return jsonError(res, 403, 'ကိုယ်ပို့ထားသော message ကိုသာ ပြင်နိုင်ပါသည်။');
    if (!content || content.length > 2000) return jsonError(res, 400, 'Message ကို ၁ မှ ၂၀၀၀ လုံးအတွင်း ထည့်ပါ။');
    updates.content = content; updates.edited_at = new Date().toISOString();
  } else if (action === 'delete') {
    if (message.sender_id !== req.user.id) return jsonError(res, 403, 'ကိုယ်ပို့ထားသော message ကိုသာ ဖျက်နိုင်ပါသည်။');
    updates.is_deleted = true; updates.content = '';
  } else if (action === 'pin') updates.is_pinned = !message.is_pinned;
  else return jsonError(res, 400, 'မသိသော message action ဖြစ်သည်။');
  const { data: updated, error: updateError } = await supabase.from('chat_messages').update(updates).eq('id', message.id)
    .select('id,conversation_id,sender_id,content,reply_to,is_deleted,is_pinned,edited_at,created_at').single();
  if (updateError) throw updateError;
  const [formatted] = await formatMessages([updated]);
  io.to(message.conversation_id).emit('message_changed', formatted);
  res.json({ success: true, message: formatted });
}));

app.get('/api/health', (_req, res) => res.status(200).json({ ok: true }));

io.use((socket, next) => {
  const sess = socket.request.session;
  const id = sess?.userId;
  if (!id) return next(new Error('authentication required'));
  userById(id).then(({ data, error }) => {
    if (error || !data) return next(new Error('authentication required'));
    socket.data.userId = data.id;
    socket.data.username = data.username;
    next();
  }).catch(next);
});
io.on('connection', socket => {
  const userId = socket.data.userId;
  if (!onlineSockets.has(userId)) onlineSockets.set(userId, new Set());
  onlineSockets.get(userId).add(socket.id);
  supabase.from('users').update({ last_seen_at: new Date().toISOString() }).eq('id', userId).then(() => {});
  io.emit('presence_update', { userId, online: true, lastSeenAt: null });
  void (async () => {
    const { data: memberships, error: membershipError } = await supabase.from('chat_conversation_members')
      .select('conversation_id').eq('user_id', userId).eq('is_deleted', false);
    if (membershipError) throw membershipError;
    const rooms = [...new Set((memberships || []).map(item => item.conversation_id).filter(validRoomId))];
    await Promise.all(rooms.map(room => socket.join(room)));
    const { data: pending, error: pendingError } = await supabase.from('chat_message_receipts')
      .select('message_id').eq('user_id', userId).eq('status', 'sent').limit(500);
    if (pendingError || !pending?.length) return;
    const ids = pending.map(item => item.message_id);
    const now = new Date().toISOString();
    const { error: updateError } = await supabase.from('chat_message_receipts').update({ status: 'delivered', updated_at: now })
      .eq('user_id', userId).in('message_id', ids);
    if (updateError) throw updateError;
    const { data: rows, error: rowsError } = await supabase.from('chat_messages').select('id,conversation_id').in('id', ids);
    if (rowsError) throw rowsError;
    const statusMap = await getMessageStatuses(ids);
    (rows || []).forEach(message => io.to(message.conversation_id).emit('receipt_update', { messageId: message.id, status: statusMap.get(message.id) || 'delivered' }));
  })().catch(error => console.error('Conversation room bootstrap failed:', error.message));
  socket.on('join_room', async (room, callback) => {
    try {
      if (!validRoomId(room) || !await isConversationMember(room, userId)) return callback?.({ success: false, error: 'Access denied' });
      socket.join(room);
      const { data, error } = await supabase.from('chat_messages').select('id,conversation_id,sender_id,content,reply_to,is_deleted,is_pinned,edited_at,created_at').eq('conversation_id', room).order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      const history = await formatMessages((data || []).reverse());
      socket.emit('room_history', { room, messages: history });
      const { data: pending, error: pendingError } = await supabase.from('chat_message_receipts').select('message_id').eq('user_id', userId).eq('status', 'sent').in('message_id', (data || []).map(row => row.id));
      if (!pendingError && pending?.length) {
        await supabase.from('chat_message_receipts').update({ status: 'delivered', updated_at: new Date().toISOString() }).eq('user_id', userId).in('message_id', pending.map(row => row.message_id));
        const statusMap = await getMessageStatuses(pending.map(receipt => receipt.message_id));
        for (const receipt of pending) socket.to(room).emit('receipt_update', { messageId: receipt.message_id, status: statusMap.get(receipt.message_id) || 'delivered' });
      }
      callback?.({ success: true });
    } catch (error) { console.error('Socket join failed:', error.message); callback?.({ success: false, error: 'Conversation ကိုဖွင့်မရပါ။' }); }
  });
  socket.on('send_message', async (payload, callback) => {
    try {
      const room = payload?.room;
      const content = typeof payload?.msg === 'string' ? payload.msg.trim() : '';
      const replyTo = typeof payload?.replyTo === 'string' ? payload.replyTo : null;
      const clientId = typeof payload?.clientId === 'string' ? payload.clientId.slice(0, 80) : '';
      if (!validRoomId(room) || !socket.rooms.has(room) || !content || content.length > 2000) return callback?.({ success: false, error: 'Message မပို့နိုင်ပါ။' });
      if (replyTo) {
        const { data: original, error } = await supabase.from('chat_messages').select('id,conversation_id').eq('id', replyTo).maybeSingle();
        if (error || !original || original.conversation_id !== room) return callback?.({ success: false, error: 'Reply လုပ်မည့် message မတွေ့ပါ။' });
      }
      const { data: row, error } = await supabase.from('chat_messages').insert({ conversation_id: room, sender_id: userId, content, reply_to: replyTo })
        .select('id,conversation_id,sender_id,content,reply_to,is_deleted,is_pinned,edited_at,created_at').single();
      if (error) throw error;
      const { data: memberRows, error: memberError } = await supabase.from('chat_conversation_members').select('user_id').eq('conversation_id', room);
      if (memberError) throw memberError;
      const receipts = (memberRows || []).map(member => ({ message_id: row.id, user_id: member.user_id, status: member.user_id === userId ? 'seen' : 'sent' }));
      const { error: receiptError } = await supabase.from('chat_message_receipts').upsert(receipts, { onConflict: 'message_id,user_id' });
      if (receiptError) throw receiptError;
      await supabase.from('chat_conversation_members').update({ is_deleted: false, updated_at: new Date().toISOString() }).eq('conversation_id', room);
      for (const member of memberRows || []) {
        for (const socketId of onlineSockets.get(member.user_id) || []) io.sockets.sockets.get(socketId)?.join(room);
      }
      const activeSocketIds = io.sockets.adapter.rooms.get(room) || new Set();
      const activeUserIds = new Set([...activeSocketIds].map(id => io.sockets.sockets.get(id)?.data.userId).filter(Boolean));
      const deliveredTo = (memberRows || []).map(member => member.user_id).filter(id => id !== userId && activeUserIds.has(id));
      if (deliveredTo.length) {
        const { error: deliveredError } = await supabase.from('chat_message_receipts').update({ status: 'delivered', updated_at: new Date().toISOString() })
          .eq('message_id', row.id).in('user_id', deliveredTo).eq('status', 'sent');
        if (deliveredError) throw deliveredError;
      }
      await supabase.from('chat_conversations').update({ updated_at: new Date().toISOString() }).eq('id', room);
      const [message] = await formatMessages([row]);
      message.clientId = clientId;
      io.to(room).emit('receive_message', message);
      callback?.({ success: true, messageId: message.id, clientId, status: 'sent' });
    } catch (error) { console.error('Socket send failed:', error.message); callback?.({ success: false, error: 'Message ကို သိမ်းမရပါ။ ခဏနေရင် ထပ်ပို့ပါ။' }); }
  });
  socket.on('mark_read', async room => {
    try {
      if (!validRoomId(room) || !socket.rooms.has(room)) return;
      const { data: messages, error } = await supabase.from('chat_messages').select('id,sender_id').eq('conversation_id', room).neq('sender_id', userId).order('created_at', { ascending: false }).limit(100);
      if (error || !messages?.length) return;
      const ids = messages.map(row => row.id);
      await supabase.from('chat_message_receipts').update({ status: 'seen', updated_at: new Date().toISOString() }).eq('user_id', userId).in('message_id', ids);
      await supabase.from('chat_conversation_members').update({ last_read_at: new Date().toISOString() }).eq('conversation_id', room).eq('user_id', userId);
      const statusMap = await getMessageStatuses(messages.map(message => message.id));
      messages.forEach(message => io.to(room).emit('receipt_update', { messageId: message.id, status: statusMap.get(message.id) || 'seen' }));
    } catch (error) { console.error('Read receipt failed:', error.message); }
  });
  socket.on('disconnect', () => {
    const sockets = onlineSockets.get(userId);
    sockets?.delete(socket.id);
    if (!sockets?.size) {
      onlineSockets.delete(userId);
      const lastSeenAt = new Date().toISOString();
      supabase.from('users').update({ last_seen_at: lastSeenAt }).eq('id', userId).then(() => {});
      io.emit('presence_update', { userId, online: false, lastSeenAt });
    }
  });
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return jsonError(res, status, error.code === 'LIMIT_FILE_SIZE' ? 'ဖိုင်အရွယ်အစား သတ်မှတ်ချက်ကျော်နေပါသည်။' : 'Upload ဖိုင်ကို လက်ခံမရပါ။');
  }
  if (error.message?.startsWith('JPG,')) return jsonError(res, 400, error.message);
  console.error('Unhandled request error:', error.message);
  if (!res.headersSent) jsonError(res, 500, 'Server အမှားတစ်ခု ဖြစ်ပွားခဲ့ပါသည်။');
});

server.listen(PORT, () => console.log(`Flâsh Pro running on port ${PORT}`));
