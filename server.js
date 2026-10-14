const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const Groq = require('groq-sdk');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const SUPABASE_URL = 'https://zghlmevmxgonupbiszok.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpnaGxtZXZteGdvbnVwYmlzem9rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5NjU2MjIsImV4cCI6MjEwNzU0MTYyMn0.LEMRj1OA5d_1U2y1zpveLD_cTxQdxw3eEjidKbAXWBc';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({ secret: 'flashpro_secret_key', resave: false, saveUninitialized: true }));

const storage = multer.diskStorage({
  destination: './public/uploads/',
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Auth API
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: 'Username/Password ဖြည့်ပါ။' });
  const hashedPassword = bcrypt.hashSync(password, 10);
  const { error } = await supabase.from('users').insert([{ username, password: hashedPassword }]);
  if (error) return res.json({ success: false, message: 'Username ရှိပြီးသားဖြစ်နေပါသည်။' });
  res.json({ success: true, message: 'Account Created Successfully!' });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: 'Username/Password ဖြည့်ပါ။' });
  const { data: user } = await supabase.from('users').select('*').eq('username', username).single();
  if (user && bcrypt.compareSync(password, user.password)) {
    req.session.user = user.username;
    res.json({ success: true, username: user.username });
  } else {
    res.json({ success: false, message: 'Username သို့မဟုတ် Password မှားယွင်းနေပါသည်။' });
  }
});

app.get('/api/users', async (req, res) => {
  const { data } = await supabase.from('users').select('username');
  res.json(data || []);
});

// Settings API
app.post('/api/settings', async (req, res) => {
  const { geminiKey, groqKey } = req.body;
  if (geminiKey) await supabase.from('settings').upsert({ key: 'gemini_key', value: geminiKey });
  if (groqKey) await supabase.from('settings').upsert({ key: 'groq_key', value: groqKey });
  res.json({ success: true, message: 'API Keys Saved!' });
});

// AI Chat API
app.post('/api/ai/chat', async (req, res) => {
  const { provider, prompt } = req.body;
  try {
    if (provider === 'gemini') {
      const { data } = await supabase.from('settings').select('value').eq('key', 'gemini_key').single();
      if (!data?.value) return res.status(400).json({ error: 'Settings တွင် Gemini Key ဖြည့်ပါ' });
      const ai = new GoogleGenAI({ apiKey: data.value });
      const response = await ai.models.generateContent({ model: 'gemini-1.5-flash', contents: prompt });
      return res.json({ text: response.text });
    }
    if (provider === 'groq') {
      const { data } = await supabase.from('settings').select('value').eq('key', 'groq_key').single();
      if (!data?.value) return res.status(400).json({ error: 'Settings တွင် Groq Key ဖြည့်ပါ' });
      const groq = new Groq({ apiKey: data.value });
      const completion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.1-8b-instant',
      });
      return res.json({ text: completion.choices[0]?.message?.content });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Downloader API (Using Public Cobalt API Engine)
app.post('/api/download', async (req, res) => {
  const { url } = req.body;
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch('https://api.cobalt.tools/api/json', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url })
    });
    const data = await response.json();
    if (data.url) {
      res.json({ success: true, downloadUrl: data.url, title: 'Video Stream Ready' });
    } else {
      res.json({ success: false, error: 'Video Link မထုတ်ယူနိုင်ပါ' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Music API
app.post('/api/music/upload', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No File' });
  const uploader = req.session.user || 'Guest';
  const fileUrl = `/uploads/${req.file.filename}`;
  await supabase.from('music').insert([{ title: req.file.originalname, file_url: fileUrl, uploader }]);
  res.json({ success: true });
});

app.get('/api/music/list', async (req, res) => {
  const { data } = await supabase.from('music').select('*').order('id', { ascending: false });
  res.json(data || []);
});

// Realtime Chat Engine
io.on('connection', (socket) => {
  socket.on('join_room', (room) => socket.join(room));
  socket.on('send_message', (data) => io.to(data.room).emit('receive_message', data));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  
