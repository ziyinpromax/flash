const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const ytdl = require('@distube/ytdl-core');
const { GoogleGenAI } = require('@google/genai');
const Groq = require('groq-sdk');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Supabase Connection Setup
const SUPABASE_URL = 'https://zghlmevmxgonupbiszok.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpnaGxtZXZteGdvbnVwYmlzem9rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5NjU2MjIsImV4cCI6MjEwNzU0MTYyMn0.LEMRj1OA5d_1U2y1zpveLD_cTxQdxw3eEjidKbAXWBc';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({ secret: 'flashpro_secret_key', resave: false, saveUninitialized: true }));

// Multer Upload Configuration
const storage = multer.diskStorage({
  destination: './public/uploads/',
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// 1. Authentication API
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  const hashedPassword = bcrypt.hashSync(password, 10);
  const { error } = await supabase.from('users').insert([{ username, password: hashedPassword }]);
  if (error) return res.json({ success: false, message: 'Username already exists.' });
  res.json({ success: true, message: 'Account created successfully!' });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const { data: user } = await supabase.from('users').select('*').eq('username', username).single();
  if (user && bcrypt.compareSync(password, user.password)) {
    req.session.user = user.username;
    res.json({ success: true, username: user.username });
  } else {
    res.json({ success: false, message: 'Invalid credentials.' });
  }
});

// 2. Settings API
app.post('/api/settings', async (req, res) => {
  const { geminiKey, groqKey } = req.body;
  if (geminiKey) await supabase.from('settings').upsert({ key: 'gemini_key', value: geminiKey });
  if (groqKey) await supabase.from('settings').upsert({ key: 'groq_key', value: groqKey });
  res.json({ success: true, message: 'API Keys updated successfully!' });
});

// 3. AI Chat Engine API
app.post('/api/ai/chat', async (req, res) => {
  const { provider, model, prompt } = req.body;
  try {
    if (provider === 'gemini') {
      const { data } = await supabase.from('settings').select('value').eq('key', 'gemini_key').single();
      if (!data?.value) return res.status(400).json({ error: 'Gemini API key missing in Settings!' });
      const ai = new GoogleGenAI({ apiKey: data.value });
      const response = await ai.models.generateContent({ model: model || 'gemini-2.5-flash', contents: prompt });
      return res.json({ text: response.text });
    }
    if (provider === 'groq') {
      const { data } = await supabase.from('settings').select('value').eq('key', 'groq_key').single();
      if (!data?.value) return res.status(400).json({ error: 'Groq API key missing in Settings!' });
      const groq = new Groq({ apiKey: data.value });
      const completion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: model || 'llama-3.3-70b-versatile',
      });
      return res.json({ text: completion.choices[0]?.message?.content });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Video Downloader API
app.post('/api/download', async (req, res) => {
  const { url } = req.body;
  try {
    const info = await ytdl.getInfo(url);
    const format = ytdl.chooseFormat(info.formats, { quality: 'highestvideo' });
    res.json({ 
      success: true, 
      downloadUrl: format.url, 
      title: info.videoDetails.title 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Video extraction failed!' });
  }
});

// 5. Music Player & Upload API
app.post('/api/music/upload', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file uploaded.' });
  const uploader = req.session.user || 'Guest';
  const fileUrl = `/uploads/${req.file.filename}`;
  await supabase.from('music').insert([{ title: req.file.originalname, file_url: fileUrl, uploader }]);
  res.json({ success: true });
});

app.get('/api/music/list', async (req, res) => {
  const { data } = await supabase.from('music').select('*').order('id', { ascending: false });
  res.json(data || []);
});

// 6. Socket.io Realtime Chat Engine
io.on('connection', (socket) => {
  socket.on('join_room', (room) => socket.join(room));
  socket.on('send_message', (data) => io.to(data.room).emit('receive_message', data));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Flâsh Pro Server running on Port ${PORT}`));
