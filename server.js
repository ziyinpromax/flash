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
const { GoogleGenAI } = require('@google/genai');
const Groq = require('groq-sdk');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
const SESSION_SECRET = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'local-development-only-session-secret');

if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be configured in production.');
}

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zghlmevmxgonupbiszok.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpnaGxtZXZteGdvbnVwYmlzem9rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5NjU2MjIsImV4cCI6MjEwNzU0MTYyMn0.LEMRj1OA5d_1U2y1zpveLD_cTxQdxw3eEjidKbAXWBc';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

const sessionMiddleware = session({
  name: 'flashpro.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000
  }
});
app.use(sessionMiddleware);
io.engine.use((req, res, next) => sessionMiddleware(req, res, next));

function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ success: false, error: 'ကျေးဇူးပြု၍ အကောင့်ဝင်ပါ။' });
  }
  next();
}

function privateRoomFor(userA, userB) {
  return `private:${[userA, userB].sort().map(encodeURIComponent).join(':')}`;
}

function validPrivateRoom(room, username) {
  if (typeof room !== 'string' || !room.startsWith('private:')) return false;
  let pair;
  try { pair = room.slice('private:'.length).split(':').map(decodeURIComponent); }
  catch { return false; }
  return pair.length === 2 && pair.includes(username) && pair[0] !== pair[1];
}

// Authentication
app.get('/api/me', (req, res) => {
  res.json(req.session?.user ? { loggedIn: true, username: req.session.user } : { loggedIn: false });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ success: false, error: 'Logout မအောင်မြင်ပါ။' });
    res.clearCookie('flashpro.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    res.json({ success: true });
  });
});

app.post('/api/register', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!/^[\p{L}\p{N}_.-]{3,24}$/u.test(username)) {
    return res.status(400).json({ success: false, message: 'Username ကို စာလုံး၊ ဂဏန်း၊ underscore၊ dot၊ hyphen ၃ မှ ၂၄ လုံးအတွင်း ထည့်ပါ။' });
  }
  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({ success: false, message: 'Password ကို အနည်းဆုံး ၈ လုံး ထည့်ပါ။' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 12);
    const { error } = await supabase.from('users').insert([{ username, password: hashedPassword }]);
    if (error) {
      console.error('Registration database insert failed:', {
        code: error.code, message: error.message
      });
      if (error.code === '23505') {
        return res.status(409).json({ success: false, message: 'ဤ username ကို အသုံးပြုထားပြီးပါပြီ။ အခြား username သုံးပါ။' });
      }
      if (error.code === '42501') {
        return res.status(503).json({ success: false, message: 'Database က account ဖန်တီးခွင့်မပြုပါ (RLS/permission)။ Server-only Supabase key နှင့် database policies ကို စစ်ဆေးပါ။' });
      }
      if (['42P01', 'PGRST204', 'PGRST205', '42703', '23502'].includes(error.code)) {
        return res.status(503).json({ success: false, message: 'Database users table သို့မဟုတ် လိုအပ်သော columns မကိုက်ညီပါ။ README ထဲက schema ကို စစ်ဆေးပါ။' });
      }
      const dbCode = error.code ? ` (code: ${error.code})` : '';
      return res.status(503).json({ success: false, message: `Database ထဲသို့ account သိမ်းမရပါ${dbCode}။ Server logs နှင့် Supabase configuration ကို စစ်ဆေးပါ။` });
    }
    res.json({ success: true, message: 'အကောင့်ဖွင့်ခြင်း အောင်မြင်ပါသည်။' });
  } catch (err) {
    console.error('Registration failed unexpectedly:', err.message);
    res.status(503).json({ success: false, message: 'Database ကို ယခုဆက်သွယ်မရပါ။ Server logs နှင့် Supabase URL/key ကို စစ်ဆေးပါ။' });
  }
});

app.post('/api/login', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ success: false, message: 'Username နှင့် Password ဖြည့်ပါ။' });

  try {
    const { data: user, error } = await supabase.from('users').select('username,password').eq('username', username).maybeSingle();
    if (error) throw error;
    if (user && await bcrypt.compare(password, user.password)) {
      req.session.user = user.username;
      return res.json({ success: true, username: user.username });
    }
    res.status(401).json({ success: false, message: 'Username သို့မဟုတ် Password မှားယွင်းနေပါသည်။' });
  } catch (err) {
    console.error('Login failed:', err.message);
    res.status(500).json({ success: false, message: 'Login ဝန်ဆောင်မှုကို ယခုချိတ်ဆက်မရပါ။' });
  }
});

app.get('/api/users', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('users').select('username').order('username');
  if (error) return res.status(503).json({ success: false, error: 'အသုံးပြုသူစာရင်းကို မဖတ်နိုင်ပါ။' });
  res.json((data || []).filter(user => user.username !== req.session.user));
});

// Personal API keys. Encrypt keys before storing and never return their values to the browser.
function settingKey(username, provider) {
  return `${username}:${provider}_key`;
}

function encryptApiKey(value) {
  const key = crypto.createHash('sha256').update(`${SESSION_SECRET}|flash-api-keys`).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}

function decryptApiKey(value) {
  if (typeof value !== 'string') return '';
  if (!value.startsWith('enc:v1:')) return value; // Read pre-existing keys; they are re-encrypted when saved again.
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

const AI_PROVIDERS = ['gemini', 'groq', 'deepseek', 'openai', 'xai', 'manus'];
app.get('/api/settings', requireAuth, async (req, res) => {
  const keys = AI_PROVIDERS.map(provider => settingKey(req.session.user, provider));
  const { data, error } = await supabase.from('settings').select('key,value').in('key', keys);
  if (error) return res.status(503).json({ success: false, error: 'Settings ကို မဖတ်နိုင်ပါ။' });
  const saved = new Set((data || []).filter(row => Boolean(row.value)).map(row => row.key));
  res.json(Object.fromEntries(AI_PROVIDERS.map(provider => [`${provider}Configured`, saved.has(settingKey(req.session.user, provider))])));
});

app.post('/api/settings', requireAuth, async (req, res) => {
  for (const provider of AI_PROVIDERS) {
    const key = settingKey(req.session.user, provider);
    const clearField = `clear${provider[0].toUpperCase()}${provider.slice(1)}`;
    if (req.body?.[clearField] === true) {
      const { error } = await supabase.from('settings').delete().eq('key', key);
      if (error) return res.status(503).json({ success: false, error: 'API key ကို ဖယ်ရှားမရပါ။' });
      if (provider === 'manus') await supabase.from('settings').delete().eq('key', `${req.session.user}:manus_task_id`);
      continue;
    }
    const value = req.body?.[`${provider}Key`];
    if (typeof value === 'string' && value.trim()) {
      if (value.trim().length > 1000) return res.status(400).json({ success: false, error: 'API key အရှည် မမှန်ပါ။' });
      const { error } = await supabase.from('settings').upsert({ key, value: encryptApiKey(value.trim()) }, { onConflict: 'key' });
      if (error) return res.status(503).json({ success: false, error: 'API key ကို သိမ်းမရပါ။' });
    }
  }
  res.json({ success: true, message: 'သင့်အကောင့်အတွက် API key များကို လုံခြုံစွာ သိမ်းပြီးပါပြီ။' });
});

async function callOpenAICompatible({ endpoint, key, model, prompt }) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(45000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Provider returned HTTP ${response.status}`);
  return data.choices?.[0]?.message?.content || '';
}

async function callManus({ apiKey, username, prompt }) {
  const base = 'https://api.manus.ai/v2';
  const headers = { 'Content-Type': 'application/json', 'x-manus-api-key': apiKey };
  const ask = `This is a text-only chat. Reply directly to the user's question. Do not use integrations, connectors, or tools, and do not perform external actions.\n\nUser: ${prompt}`;
  const taskKey = `${username}:manus_task_id`;
  let taskId = await readSetting(taskKey);
  const requestStartedAt = Date.now();

  if (!taskId) {
    const response = await fetch(`${base}/task.create`, {
      method: 'POST', headers,
      body: JSON.stringify({
        message: { content: ask, connectors: [] },
        title: 'Flâsh Pro AI chat',
        share_visibility: 'private',
        interactive_mode: false,
        agent_profile: 'standard'
      }),
      signal: AbortSignal.timeout(20000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.task_id) throw new Error(data.error?.message || 'Manus API task could not be created.');
    taskId = data.task_id;
    const { error } = await supabase.from('settings').upsert({ key: taskKey, value: taskId }, { onConflict: 'key' });
    if (error) throw new Error('Manus task was created, but its chat session could not be saved.');
  } else {
    const response = await fetch(`${base}/task.sendMessage`, {
      method: 'POST', headers,
      body: JSON.stringify({ task_id: taskId, message: { content: ask }, clear_connectors: true }),
      signal: AbortSignal.timeout(20000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || 'Manus API could not continue this chat. Remove and re-add your Manus key to start a new thread.');
  }

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const [messagesResponse, detailResponse] = await Promise.all([
      fetch(`${base}/task.listMessages?task_id=${encodeURIComponent(taskId)}&order=desc&limit=20`, { headers, signal: AbortSignal.timeout(15000) }),
      fetch(`${base}/task.detail?task_id=${encodeURIComponent(taskId)}`, { headers, signal: AbortSignal.timeout(15000) })
    ]);
    const messagesData = await messagesResponse.json().catch(() => ({}));
    const detailData = await detailResponse.json().catch(() => ({}));
    if (!messagesResponse.ok || !detailResponse.ok) throw new Error('Manus API could not retrieve the chat response.');
    const task = detailData.task || {};
    const newMessages = (messagesData.messages || []).filter(event => Number(event.timestamp || 0) >= requestStartedAt);
    const latestAnswer = newMessages.find(event => event.type === 'assistant_message' && event.assistant_message?.content)?.assistant_message?.content;
    if (task.status === 'error') throw new Error('Manus Agent reported an error.');
    if (task.status === 'waiting') {
      if (latestAnswer) return latestAnswer;
      throw new Error('Manus Agent is waiting for input. Open your Manus task to continue this thread.');
    }
    if (task.status === 'stopped' && task.has_running_background_jobs === false) {
      if (latestAnswer) return latestAnswer;
      const agentError = newMessages.find(event => event.type === 'error_message')?.error_message?.content;
      throw new Error(agentError || 'Manus Agent stopped without a text response.');
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error('Manus is still working. Please try again shortly; the task continues in your Manus account.');
}

app.post('/api/ai/chat', requireAuth, async (req, res) => {
  const provider = req.body?.provider;
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!AI_PROVIDERS.includes(provider)) return res.status(400).json({ error: 'AI provider ကို ရွေးချယ်ပါ။' });
  if (!prompt || prompt.length > 6000) return res.status(400).json({ error: 'မေးခွန်းကို ဖြည့်ပါ (အများဆုံး ၆,၀၀၀ စာလုံး)။' });

  try {
    const storedKey = await readSetting(settingKey(req.session.user, provider));
    if (!storedKey) return res.status(400).json({ error: 'Settings ထဲတွင် သင့်ကိုယ်ပိုင် API key ထည့်ပါ။' });
    const apiKey = decryptApiKey(storedKey);
    let text = '';
    if (provider === 'gemini') {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash', contents: prompt });
      text = response.text || '';
    } else if (provider === 'groq') {
      const groq = new Groq({ apiKey });
      const completion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b'
      });
      text = completion.choices[0]?.message?.content || '';
    } else if (provider === 'deepseek') {
      text = await callOpenAICompatible({ endpoint: 'https://api.deepseek.com/chat/completions', key: apiKey, model: process.env.DEEPSEEK_MODEL || 'deepseek-flash', prompt });
    } else if (provider === 'openai') {
      text = await callOpenAICompatible({ endpoint: 'https://api.openai.com/v1/chat/completions', key: apiKey, model: process.env.OPENAI_MODEL || 'gpt-4.1-mini', prompt });
    } else if (provider === 'xai') {
      text = await callOpenAICompatible({ endpoint: 'https://api.x.ai/v1/chat/completions', key: apiKey, model: process.env.XAI_MODEL || 'grok-4.7', prompt });
    } else {
      text = await callManus({ apiKey, username: req.session.user, prompt });
    }
    res.json({ text });
  } catch (err) {
    console.error(`${provider} AI request failed:`, err.message);
    res.status(502).json({ error: err.message?.startsWith('Manus') ? err.message : 'AI service ကို ခေါ်ယူ၍မရပါ။ API key၊ model နှင့် provider ကို စစ်ဆေးပါ။' });
  }
});

// Cobalt API: configure an instance you own or are explicitly allowed to use.
const COBALT_API_URL = process.env.COBALT_API_URL;
const COBALT_API_KEY = process.env.COBALT_API_KEY;
function isAllowedVideoUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com') ||
      host === 'tiktok.com' || host.endsWith('.tiktok.com');
  } catch {
    return false;
  }
}

app.post('/api/download', requireAuth, async (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!isAllowedVideoUrl(url)) {
    return res.status(400).json({ success: false, error: 'မှန်ကန်သော YouTube သို့မဟုတ် TikTok video link ထည့်ပါ။' });
  }
  if (!COBALT_API_URL) {
    return res.status(503).json({ success: false, error: 'Downloader API မသတ်မှတ်ရသေးပါ။ Server admin က ခွင့်ပြုထားသော Cobalt instance ကို COBALT_API_URL ဖြင့် သတ်မှတ်ရပါမည်။' });
  }

  try {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (COBALT_API_KEY) headers.Authorization = `Api-Key ${COBALT_API_KEY}`;
    const response = await fetch(COBALT_API_URL, {
      method: 'POST', headers, body: JSON.stringify({ url, localProcessing: 'disabled' }), signal: AbortSignal.timeout(30000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const apiError = data?.error?.code;
      return res.status(502).json({ success: false, error: apiError ? `Downloader API error: ${apiError}` : `Downloader API က HTTP ${response.status} ပြန်ပေးသည်။` });
    }
    if (data.status === 'error') {
      return res.status(422).json({ success: false, error: data.error?.code || 'ဤ video ကို မရယူနိုင်ပါ။' });
    }
    if (data.status === 'local-processing') {
      return res.status(422).json({ success: false, error: 'ဤ instance က server-side processing မပေးနိုင်ပါ။ Cobalt instance configuration ကို စစ်ဆေးပါ။' });
    }
    const links = [];
    if (['tunnel', 'redirect'].includes(data.status) && typeof data.url === 'string') links.push(data.url);
    if (data.status === 'picker' && Array.isArray(data.picker)) {
      for (const item of data.picker) if (typeof item.url === 'string') links.push(item.url);
    }
    const validLinks = links.filter(link => {
      try { return new URL(link).protocol === 'https:'; } catch { return false; }
    });
    if (!validLinks.length) return res.status(502).json({ success: false, error: 'Downloader API မှ download link ပြန်မရပါ။' });
    res.json({ success: true, downloads: validLinks, filename: data.filename || data.output?.filename || '' });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    res.status(502).json({ success: false, error: timedOut ? 'Downloader တုံ့ပြန်မှု အချိန်ကျော်သွားပါသည်။' : 'Downloader API သို့ ချိတ်ဆက်မရပါ။' });
  }
});

// Music upload. Files are local to the server; use persistent storage for deployments with ephemeral disks.
const allowedAudioExtensions = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.webm']);
const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try { await fs.mkdir(UPLOAD_DIR, { recursive: true }); cb(null, UPLOAD_DIR); }
    catch (error) { cb(error); }
  },
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!allowedAudioExtensions.has(extension) || !file.mimetype.startsWith('audio/')) {
      return cb(new Error('MP3/WAV/OGG/M4A/AAC/FLAC/WebM အသံဖိုင်များကိုသာ တင်နိုင်ပါသည်။'));
    }
    cb(null, true);
  }
});

app.post('/api/music/upload', requireAuth, upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'အသံဖိုင်ကို ရွေးပါ။' });
  const folder = typeof req.body?.folder === 'string' ? req.body.folder.trim().slice(0, 60) : 'General';
  const title = path.basename(req.file.originalname).slice(0, 180);
  let fileUrl = `/uploads/${req.file.filename}`;
  let storedRemotely = false;
  try {
    if (STORAGE_BUCKET) {
      const fileBuffer = await fs.readFile(req.file.path);
      const { error: storageError } = await supabase.storage.from(STORAGE_BUCKET).upload(req.file.filename, fileBuffer, {
        contentType: req.file.mimetype,
        upsert: false
      });
      if (storageError) throw storageError;
      storedRemotely = true;
      fileUrl = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(req.file.filename).data.publicUrl;
    }
    const { error } = await supabase.from('music').insert([{
      title, file_url: fileUrl, uploader: req.session.user, folder: folder || 'General'
    }]);
    if (error) throw error;
    if (storedRemotely) await fs.unlink(req.file.path).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    if (storedRemotely) await supabase.storage.from(STORAGE_BUCKET).remove([req.file.filename]).catch(() => {});
    await fs.unlink(req.file.path).catch(() => {});
    console.error('Music upload failed:', err.message);
    res.status(503).json({ success: false, error: 'သီချင်းဖိုင် သို့မဟုတ် အချက်အလက်ကို မသိမ်းနိုင်ပါ။ Supabase Storage/Database ကို စစ်ဆေးပါ။' });
  }
});

app.get('/api/music/list', requireAuth, async (_req, res) => {
  const { data, error } = await supabase.from('music').select('id,title,file_url,uploader,folder').order('id', { ascending: false });
  if (error) return res.status(503).json({ success: false, error: 'သီချင်းစာရင်းကို မဖတ်နိုင်ပါ။' });
  res.json(data || []);
});

app.delete('/api/music/delete/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const { data: song, error: findError } = await supabase.from('music').select('id,uploader,file_url').eq('id', id).maybeSingle();
  if (findError || !song) return res.status(404).json({ success: false, error: 'သီချင်း မတွေ့ပါ။' });
  if (song.uploader !== req.session.user) return res.status(403).json({ success: false, error: 'ကိုယ်ပိုင်သီချင်းကိုသာ ဖျက်နိုင်ပါသည်။' });
  const { error } = await supabase.from('music').delete().eq('id', id);
  if (error) return res.status(503).json({ success: false, error: 'သီချင်းစာရင်းမှ ဖျက်မရပါ။' });
  const basename = path.basename(song.file_url || '');
  if (basename && STORAGE_BUCKET && song.file_url?.startsWith(`${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/`)) {
    await supabase.storage.from(STORAGE_BUCKET).remove([basename]).catch(() => {});
  } else if (basename && song.file_url?.startsWith('/uploads/')) {
    await fs.unlink(path.join(UPLOAD_DIR, basename)).catch(() => {});
  }
  res.json({ success: true });
});

// Real-time chat: authenticate the socket and authorize every room/message on the server.
const chatHistory = new Map();
io.use((socket, next) => {
  if (!socket.request.session?.user) return next(new Error('authentication required'));
  socket.data.username = socket.request.session.user;
  next();
});

io.on('connection', socket => {
  const username = socket.data.username;
  socket.on('join_room', room => {
    if (room !== 'group:global' && !validPrivateRoom(room, username)) return;
    socket.join(room);
    socket.emit('room_history', { room, messages: chatHistory.get(room) || [] });
  });

  socket.on('send_message', payload => {
    const room = payload?.room;
    const msg = typeof payload?.msg === 'string' ? payload.msg.trim() : '';
    const authorized = room === 'group:global' || validPrivateRoom(room, username);
    if (!authorized || !socket.rooms.has(room) || !msg || msg.length > 2000) return;
    const message = { room, user: username, msg, sentAt: Date.now() };
    const history = chatHistory.get(room) || [];
    history.push(message);
    if (history.length > 100) history.shift();
    chatHistory.set(room, history);
    io.to(room).emit('receive_message', message);
  });
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ success: false, error: err.code === 'LIMIT_FILE_SIZE' ? 'ဖိုင်အရွယ်အစား 25 MB ထက်မကျော်ရပါ။' : 'Upload ဖိုင်ကို လက်ခံမရပါ။' });
  }
  if (err.message?.startsWith('MP3/')) return res.status(400).json({ success: false, error: err.message });
  console.error('Unhandled request error:', err.message);
  res.status(500).json({ success: false, error: 'Server အမှားတစ်ခု ဖြစ်ပွားခဲ့ပါသည်။' });
});

server.listen(PORT, () => console.log(`Flâsh Pro running on port ${PORT}`));
