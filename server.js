const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const youtubedl = require('yt-dlp-exec');
const { GoogleGenAI } = require('@google/genai');
const Groq = require('groq-sdk');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Supabase Configuration
const SUPABASE_URL = 'https://zghlmevmxgonupbiszok.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpnaGxtZXZteGdvbnVwYmlzem9rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5NjU2MjIsImV4cCI6MjEwNzU0MTYyMn0.LEMRj1OA5d_1U2y1zpveLD_cTxQdxw3eEjidKbAXWBc';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({ secret: 'flashpro_secret_key', resave: false, saveUninitialized: true }));

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: './public/uploads/',
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// -------------------------------------------------------------
// 1. AUTHENTICATION API (Supabase Integration)
// -------------------------------------------------------------
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  const hashedPassword = bcrypt.hashSync(password, 10);

  const { data, error } = await supabase
    .from('users')
    .insert([{ username, password: hashedPassword }]);

  if (error) {
    return res.json({ success: false, message: 'Username already exists or database error.' });
  }
  res.json({ success: true, message: 'Registration successful!' });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('username', username)
    .single();

  if (user && bcrypt.compareSync(password, user.password)) {
    req.session.user = user.username;
    res.json({ success: true, username: user.username });
  } else {
    res.json({ success: false, message: 'Invalid username or password.' });
  }
});

// -------------------------------------------------------------
// 2. SETTINGS API (Store Gemini/Groq Keys in Supabase)
// -------------------------------------------------------------
app.post('/api/settings', async (req, res) => {
  const { geminiKey, groqKey } = req.body;

  if (geminiKey) {
    await supabase.from('settings').upsert({ key: 'gemini_key', value: geminiKey });
  }
  if (groqKey) {
    await supabase.from('settings').upsert({ key: 'groq_key', value: groqKey });
  }
  res.json({ success: true, message: 'API Keys updated in Supabase!' });
});

// -------------------------------------------------------------
// 3. AI CHAT ENGINE (Gemini & Groq Models)
// -------------------------------------------------------------
app.post('/api/ai/chat', async (req, res) => {
  const { provider, model, prompt } = req.body;

  try {
    if (provider === 'gemini') {
      const { data } = await supabase.from('settings').select('value').eq('key', 'gemini_key').single();
      if (!data?.value) return res.status(400).json({ error: 'Gemini API key is not set in Settings!' });

      const ai = new GoogleGenAI({ apiKey: data.value });
      const response = await ai.models.generateContent({
        model: model || 'gemini-2.5-flash',
        contents: prompt,
      });
      return res.json({ text: response.text });
    }

    if (provider === 'groq') {
      const { data } = await supabase.from('settings').select('value').eq('key', 'groq_key').single();
      if (!data?.value) return res.status(400).json({ error: 'Groq API key is not set in Settings!' });

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

// -------------------------------------------------------------
// 4. VIDEO DOWNLOADER API
// -------------------------------------------------------------
app.post('/api/download', async (req, res) => {
  const { url } = req.body;
  try {
    const output = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
    });
    res.json({ success: true, downloadUrl: output.url || output.requested_downloads[0].url, title: output.title });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Download extraction failed.' });
  }
});

// -------------------------------------------------------------
// 5. MUSIC PLAYER ENGINE
// -------------------------------------------------------------
app.post('/api/music/upload', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file uploaded.' });
  const uploader = req.session.user || 'Guest';
  const fileUrl = `/uploads/${req.file.filename}`;

  await supabase.from('music').insert([{ title: req.file.originalname, file_url: fileUrl, uploader }]);
  res.json({ success: true });
});

app.get('/api/music/list', async (req, res) => {
  const { data, error } = await supabase.from('music').select('*').order('id', { ascending: false });
  res.json(data || []);
});

// -------------------------------------------------------------
// 6. REALTIME CHAT & GROUP CHAT ENGINE (Socket.io)
// -------------------------------------------------------------
io.on('connection', (socket) => {
  socket.on('join_group', (room) => socket.join(room));
  socket.on('group_message', (data) => {
    io.to(data.room).emit('receive_message', data);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Flâsh Pro running on Port ${PORT}`));
        
