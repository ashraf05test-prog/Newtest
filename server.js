const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/temp', express.static(TEMP_DIR));

// ========== JOB SYSTEM ==========
const jobs = {};

function createJob() {
  const id = Date.now() + '_' + Math.random().toString(36).substr(2, 8);
  jobs[id] = { status: 'processing' };
  setTimeout(() => delete jobs[id], 10 * 60 * 1000);
  return id;
}

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

app.get('/api/job/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ========== DOWNLOAD ==========
app.post('/api/download', async (req, res) => {
  const { url, quality = 'best', mute = true } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const jobId = createJob();
  res.json({ jobId, status: 'processing' });

  (async () => {
    try {
      const outTemplate = path.join(TEMP_DIR, `${jobId}.%(ext)s`);

      let fmt = 'best[ext=mp4]/best';
      if (quality === '1080p') fmt = 'bestvideo[height<=1080][ext=mp4]+bestaudio/best[height<=1080]/best';
      else if (quality === '720p') fmt = 'bestvideo[height<=720][ext=mp4]+bestaudio/best[height<=720]/best';
      else if (quality === '480p') fmt = 'bestvideo[height<=480][ext=mp4]+bestaudio/best[height<=480]/best';

      const cmd = `yt-dlp -f "${fmt}" --merge-output-format mp4 --write-thumbnail --convert-thumbnails jpg --no-playlist --retries 3 --socket-timeout 30 --no-warnings -o "${outTemplate}" "${url}"`;

      console.log('[DL]', url);
      await execAsync(cmd, { timeout: 120000 });

      const files = fs.readdirSync(TEMP_DIR);
      const mp4 = files.find(f => f.startsWith(jobId) && f.endsWith('.mp4'));
      if (!mp4) throw new Error('ডাউনলোড ব্যর্থ - ফাইল পাওয়া যায়নি');

      let videoPath = path.join(TEMP_DIR, mp4);

      if (mute) {
        const mutedPath = path.join(TEMP_DIR, `${jobId}_muted.mp4`);
        try {
          await execAsync(`ffmpeg -i "${videoPath}" -an -c:v copy "${mutedPath}" -y`, { timeout: 60000 });
          fs.unlinkSync(videoPath);
          videoPath = mutedPath;
        } catch {}
      }

      let duration = '?';
      try {
        const { stdout } = await execAsync(`ffprobe -v quiet -print_format json -show_format "${videoPath}"`);
        const secs = parseFloat(JSON.parse(stdout).format?.duration || 0);
        duration = `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
      } catch {}

      let title = 'ভিডিও';
      try {
        const { stdout } = await execAsync(`yt-dlp --skip-download --print title "${url}" 2>/dev/null`, { timeout: 15000 });
        if (stdout.trim()) title = stdout.trim();
      } catch {}

      const thumb = fs.readdirSync(TEMP_DIR).find(f => f.startsWith(jobId) && (f.endsWith('.jpg') || f.endsWith('.webp')));

      jobs[jobId] = {
        status: 'done',
        result: {
          success: true,
          filename: path.basename(videoPath),
          filepath: videoPath,
          title,
          duration,
          size: (fs.statSync(videoPath).size / 1024 / 1024).toFixed(1) + 'MB',
          thumbnail: thumb ? `/temp/${thumb}` : null,
          muted: mute
        }
      };
      console.log('[DL OK]', title);
    } catch (err) {
      console.error('[DL ERR]', err.message);
      jobs[jobId] = { status: 'error', error: err.message };
    }
  })();
});

// ========== EXTRACT AUDIO ==========
app.post('/api/extract-audio', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const jobId = createJob();
  res.json({ jobId, status: 'processing' });

  (async () => {
    try {
      const outTemplate = path.join(TEMP_DIR, `${jobId}.%(ext)s`);
      await execAsync(`yt-dlp -f "bestaudio/best" --extract-audio --audio-format mp3 --audio-quality 192K --no-playlist --retries 3 -o "${outTemplate}" "${url}"`, { timeout: 120000 });

      const audio = fs.readdirSync(TEMP_DIR).find(f => f.startsWith(jobId));
      if (!audio) throw new Error('অডিও পাওয়া যায়নি');

      const audioPath = path.join(TEMP_DIR, audio);
      let title = 'অডিও';
      try {
        const { stdout } = await execAsync(`yt-dlp --skip-download --print title "${url}" 2>/dev/null`, { timeout: 15000 });
        if (stdout.trim()) title = stdout.trim();
      } catch {}

      jobs[jobId] = {
        status: 'done',
        result: {
          success: true, title,
          audioUrl: `/temp/${audio}`,
          filepath: audioPath,
          size: (fs.statSync(audioPath).size / 1024 / 1024).toFixed(1) + 'MB'
        }
      };
    } catch (err) {
      jobs[jobId] = { status: 'error', error: err.message };
    }
  })();
});

// ========== MERGE AUDIO ==========
app.post('/api/merge-audio', async (req, res) => {
  const { videoPath, audioPath } = req.body;
  try {
    if (!videoPath || !fs.existsSync(videoPath)) throw new Error('ভিডিও ফাইল নেই: ' + videoPath);

    let localAudio = audioPath;
    if (audioPath && audioPath.startsWith('/temp/')) localAudio = path.join(TEMP_DIR, path.basename(audioPath));
    if (!localAudio || !fs.existsSync(localAudio)) throw new Error('অডিও ফাইল নেই। আবার অডিও যোগ করুন।');

    const outName = path.basename(videoPath).replace(/_muted|_merged/g, '').replace('.mp4', '_merged.mp4');
    const outFile = path.join(TEMP_DIR, outName);

    await execAsync(`ffmpeg -i "${videoPath}" -stream_loop -1 -i "${localAudio}" -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -shortest "${outFile}" -y`, { timeout: 180000 });
    if (!fs.existsSync(outFile)) throw new Error('মার্জ হয়নি');

    if (videoPath !== outFile && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    res.json({ success: true, outputPath: outFile, filename: outName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== AI GENERATE ==========
app.post('/api/ai-generate', async (req, res) => {
  const { service, apiKey, prompt } = req.body;
  try {
    const fetch = (await import('node-fetch')).default;
    let text = '';

    if (service === 'gemini') {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey || process.env.GEMINI_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9, maxOutputTokens: 1500 } })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message);
      text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else if (service === 'grok') {
      const r = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey || process.env.GROK_API_KEY}` },
        body: JSON.stringify({ model: 'grok-beta', messages: [{ role: 'user', content: prompt }], temperature: 0.9, max_tokens: 1500 })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message);
      text = d.choices?.[0]?.message?.content || '';
    } else if (service === 'openai') {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey || process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'gpt-4-turbo-preview', messages: [{ role: 'user', content: prompt }], temperature: 0.9, max_tokens: 1500 })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message);
      text = d.choices?.[0]?.message?.content || '';
    }

    try {
      const p = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
      res.json({ title: p.title || '', description: p.description || '', hashtags: p.hashtags || [], tags: p.tags || [], category: p.category || '' });
    } catch {
      res.json({ title: text.substring(0, 100), description: '', hashtags: (text.match(/#[^\s]+/g) || []).slice(0, 20), tags: [], category: '' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== UPLOAD YOUTUBE ==========
app.post('/api/upload', async (req, res) => {
  const { filepath, title, description, tags, hashtags, privacy, categoryId, deleteAfter } = req.body;
  try {
    const t = loadTokens();
    const token = t.access_token || process.env.YT_ACCESS_TOKEN;
    if (!token) throw new Error('YouTube সংযুক্ত নয়');
    if (!filepath || !fs.existsSync(filepath)) throw new Error('ফাইল নেই');

    const fetch = (await import('node-fetch')).default;
    const meta = {
      snippet: { title: (title || 'Video').substring(0, 100), description: `${description || ''}\n\n${(hashtags || []).join(' ')}`.trim().substring(0, 5000), tags: (tags || []).slice(0, 30), categoryId: categoryId || '22' },
      status: { privacyStatus: privacy || 'private', selfDeclaredMadeForKids: false }
    };

    const fileSize = fs.statSync(filepath).size;
    const initRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': fileSize },
      body: JSON.stringify(meta)
    });
    if (!initRes.ok) throw new Error('Init failed: ' + await initRes.text());

    const uploadUrl = initRes.headers.get('location');
    const buf = fs.readFileSync(filepath);
    const upRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': buf.length }, body: buf });
    if (!upRes.ok) throw new Error('Upload failed: ' + await upRes.text());

    const data = await upRes.json();
    if (deleteAfter && fs.existsSync(filepath)) fs.unlinkSync(filepath);
    res.json({ success: true, videoId: data.id, url: `https://youtu.be/${data.id}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== ZIP + DRIVE ==========
app.post('/api/export-zip', async (req, res) => {
  const { filepaths, uploadToDrive, driveFolderId } = req.body;
  try {
    const archiver = require('archiver');
    const zipName = `videos_${Date.now()}.zip`;
    const zipPath = path.join(TEMP_DIR, zipName);

    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(zipPath);
      const arc = archiver('zip', { zlib: { level: 6 } });
      out.on('close', resolve); arc.on('error', reject); arc.pipe(out);
      (filepaths || []).forEach(fp => { if (fp && fs.existsSync(fp)) arc.file(fp, { name: path.basename(fp) }); });
      arc.finalize();
    });

    if (uploadToDrive) {
      try {
        const fetch = (await import('node-fetch')).default;
        const FormData = (await import('form-data')).default;
        const t = loadTokens();
        const token = t.drive_access_token || process.env.DRIVE_ACCESS_TOKEN;
        if (token) {
          const form = new FormData();
          form.append('metadata', JSON.stringify({ name: zipName, parents: driveFolderId ? [driveFolderId] : [] }), { contentType: 'application/json' });
          form.append('file', fs.createReadStream(zipPath), { contentType: 'application/zip' });
          const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
            method: 'POST', headers: { 'Authorization': `Bearer ${token}`, ...form.getHeaders() }, body: form
          });
          if (r.ok) {
            const d = await r.json();
            return res.json({ success: true, driveUrl: `https://drive.google.com/file/d/${d.id}/view` });
          }
        }
      } catch {}
    }

    res.json({ success: true, downloadUrl: `/temp/${zipName}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== VIDEO STREAM ==========
app.get('/api/stream', (req, res) => {
  const filePath = path.join(TEMP_DIR, path.basename(req.query.file || ''));
  if (!req.query.file || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s), end = e ? parseInt(e) : stat.size - 1;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': 'video/mp4' });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4' });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ========== DELETE ==========
app.post('/api/delete', (req, res) => {
  try { if (req.body.filepath && fs.existsSync(req.body.filepath)) fs.unlinkSync(req.body.filepath); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== STATUS ==========
app.get('/api/status', (req, res) => {
  const t = loadTokens();
  res.json({ youtube: !!t.access_token, drive: !!t.drive_access_token, ytChannel: t.channel_name || null });
});

// ========== TOKEN STORAGE ==========
const TOKEN_FILE = path.join(__dirname, 'tokens.json');
function saveTokens(t) { fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2)); }
function loadTokens() { try { if (fs.existsSync(TOKEN_FILE)) return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch {} return {}; }

// ========== YOUTUBE OAUTH ==========
app.get('/auth/youtube/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code');
  try {
    const fetch = (await import('node-fetch')).default;
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: process.env.YT_CLIENT_ID, client_secret: process.env.YT_CLIENT_SECRET, redirect_uri: `${process.env.BASE_URL}/auth/youtube/callback`, grant_type: 'authorization_code' })
    });
    const tokens = await r.json();
    if (!tokens.access_token) throw new Error(JSON.stringify(tokens));

    let channelName = '';
    try {
      const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { 'Authorization': `Bearer ${tokens.access_token}` } });
      channelName = (await ch.json()).items?.[0]?.snippet?.title || '';
    } catch {}

    saveTokens({ ...loadTokens(), access_token: tokens.access_token, refresh_token: tokens.refresh_token, channel_name: channelName });
    res.send(`<html><body style="background:#0a0a0f;color:#06d6a0;font-family:sans-serif;text-align:center;padding:60px"><div style="font-size:48px">✅</div><h2>YouTube সংযুক্ত!</h2>${channelName ? `<p style="color:#fff">${channelName}</p>` : ''}<p style="color:#666">পেজ বন্ধ করুন</p><script>setTimeout(()=>window.close(),2000)</script></body></html>`);
  } catch (err) { res.send(`<html><body style="background:#0a0a0f;color:red;padding:40px;font-family:sans-serif"><h2>${err.message}</h2></body></html>`); }
});

// ========== DRIVE OAUTH ==========
app.get('/auth/drive/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code');
  try {
    const fetch = (await import('node-fetch')).default;
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: process.env.DRIVE_CLIENT_ID || process.env.YT_CLIENT_ID, client_secret: process.env.DRIVE_CLIENT_SECRET || process.env.YT_CLIENT_SECRET, redirect_uri: `${process.env.BASE_URL}/auth/drive/callback`, grant_type: 'authorization_code' })
    });
    const tokens = await r.json();
    if (!tokens.access_token) throw new Error(JSON.stringify(tokens));
    saveTokens({ ...loadTokens(), drive_access_token: tokens.access_token, drive_refresh_token: tokens.refresh_token });
    res.send(`<html><body style="background:#0a0a0f;color:#06d6a0;font-family:sans-serif;text-align:center;padding:60px"><div style="font-size:48px">✅</div><h2>Google Drive সংযুক্ত!</h2><p style="color:#666">পেজ বন্ধ করুন</p><script>setTimeout(()=>window.close(),2000)</script></body></html>`);
  } catch (err) { res.send(`<html><body style="background:#0a0a0f;color:red;padding:40px;font-family:sans-serif"><h2>${err.message}</h2></body></html>`); }
});

// ========== START ==========
app.listen(PORT, () => {
  console.log(`🚀 YouTube Automation Server running on port ${PORT}`);
  try { require('child_process').execSync('yt-dlp --version'); console.log('✓ yt-dlp available'); } catch { console.warn('✗ yt-dlp not found'); }
  try { require('child_process').execSync('ffmpeg -version 2>&1 | head -1'); console.log('✓ ffmpeg available'); } catch { console.warn('✗ ffmpeg not found'); }
});
