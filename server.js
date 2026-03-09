const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const upload = multer({ dest: path.join(__dirname, 'temp') });
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

// Explicit root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/job/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ========== DOWNLOAD ==========
app.post('/api/download', async (req, res) => {
  const { url, quality = 'best', mute = true, audioOnly = false } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const jobId = createJob();
  res.json({ jobId, status: 'processing' });

  (async () => {
    try {
      // Audio: title সহ filename, Video: jobId দিয়ে
      // Audio: title সহ filename (hashtag/special chars বাদ, max 60 chars), Video: jobId
      const outTemplate = audioOnly
        ? path.join(TEMP_DIR, `${jobId}_%(title).60s.%(ext)s`)
        : path.join(TEMP_DIR, `${jobId}.%(ext)s`);

      // Audio only mode
      if (audioOnly) {
        const cmd = `yt-dlp -f "bestaudio/best" --extract-audio --audio-format mp3 --audio-quality 192K --no-playlist --retries 3 --socket-timeout 30 --no-warnings --replace-in-metadata "title" "#[^\\s]*" "" --replace-in-metadata "title" "\\|.*" "" -o "${outTemplate}" "${url}"`;
        console.log('[DL AUDIO]', url);
        await execAsync(cmd, { timeout: 120000 });
        const files = fs.readdirSync(TEMP_DIR);
        const mp3 = files.find(f => f.startsWith(jobId) && f.match(/\.(mp3|m4a|ogg|opus|wav)$/i));
        if (!mp3) throw new Error('Audio download ব্যর্থ');
        const audioPath = path.join(TEMP_DIR, mp3);
        const title = mp3.replace(/^[^_]+_/, '').replace(/\.[^.]+$/, '');
        jobs[jobId] = { status: 'done', result: { filepath: audioPath, filename: mp3, title, size: fs.statSync(audioPath).size / (1024*1024) } };
        return;
      }

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
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey || process.env.GEMINI_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9, maxOutputTokens: 1500 } })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message);
      text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';

    } else if (service === 'grok') {
      // xAI Grok
      const r = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'grok-3-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.9, max_tokens: 1500 })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || JSON.stringify(d));
      text = d.choices?.[0]?.message?.content || '';

    } else if (service === 'groq') {
      // Groq (free, fast) — console.groq.com
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.9, max_tokens: 1500 })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || JSON.stringify(d));
      text = d.choices?.[0]?.message?.content || '';

    } else if (service === 'openai') {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey || process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.9, max_tokens: 1500 })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message);
      text = d.choices?.[0]?.message?.content || '';
    }

    try {
      // Clean and extract JSON
      let clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
      // Remove bad control characters
      clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
      // Extract JSON object only
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      const p = JSON.parse(jsonMatch[0]);
      res.json({ title: p.title || '', description: p.description || '', hashtags: p.hashtags || [], tags: p.tags || [], category: p.category || '' });
    } catch {
      // Last resort: extract what we can
      const titleMatch = text.match(/"title"\s*:\s*"([^"]+)"/);
      const hashTags = (text.match(/#[\w\u0980-\u09FF]+/g) || []).slice(0, 20);
      res.json({ title: titleMatch?.[1] || '', description: '', hashtags: hashTags, tags: [], category: '' });
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

function saveTokens(t) {
  // Local save
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2));
  // Drive backup (async, don't wait)
  backupTokensToDrive(t).catch(e => console.warn('[TOKEN] Drive backup failed:', e.message));
}

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (t && Object.keys(t).length > 0) return t;
    }
  } catch {}
  return {};
}

// Drive token backup file name
const TOKEN_DRIVE_NAME = 'yta_tokens_backup.json';
let tokenDriveFileId = process.env.TOKEN_DRIVE_FILE_ID || null;

async function backupTokensToDrive(tokens) {
  try {
    const fetch = (await import('node-fetch')).default;
    const driveToken = tokens.drive_access_token;
    if (!driveToken) return;

    const content = JSON.stringify(tokens, null, 2);
    const boundary = 'tokenboundary';

    if (tokenDriveFileId) {
      // Update existing file
      await fetch(`https://www.googleapis.com/upload/drive/v3/files/${tokenDriveFileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${driveToken}`, 'Content-Type': 'application/json' },
        body: content
      });
    } else {
      // Create new file
      const meta = JSON.stringify({ name: TOKEN_DRIVE_NAME, mimeType: 'application/json' });
      const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
      const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${driveToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body
      });
      const d = await r.json();
      if (d.id) { tokenDriveFileId = d.id; console.log('[TOKEN] Drive backup created:', d.id); }
    }
  } catch (e) { console.warn('[TOKEN] Backup error:', e.message); }
}

async function restoreTokensFromDrive() {
  try {
    const fetch = (await import('node-fetch')).default;
    // Need a service token - use env vars if available
    const driveToken = process.env.DRIVE_ACCESS_TOKEN;
    if (!driveToken) return;

    // Search for backup file
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=name='${TOKEN_DRIVE_NAME}' and trashed=false&fields=files(id,name)`,
      { headers: { 'Authorization': `Bearer ${driveToken}` } }
    );
    const data = await r.json();
    if (!data.files?.length) return;

    const fileId = data.files[0].id;
    tokenDriveFileId = fileId;

    const fr = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { 'Authorization': `Bearer ${driveToken}` }
    });
    const tokens = await fr.json();
    if (tokens && tokens.access_token) {
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
      console.log('[TOKEN] Restored from Drive ✅');
    }
  } catch (e) { console.warn('[TOKEN] Restore failed:', e.message); }
}

// On startup, try to restore tokens from Drive
restoreTokensFromDrive();

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

// ========== SERVER-SIDE SCHEDULER ==========
const SCHED_FILE = path.join(__dirname, 'schedule.json');

function loadSchedConfig() {
  try {
    if (fs.existsSync(SCHED_FILE)) return JSON.parse(fs.readFileSync(SCHED_FILE, 'utf8'));
  } catch {}
  return { enabled: false, slots: [], days: [0,1,2,3,4,5,6], folderId: '', audioFolderId: '', maxVideos: 3, privacy: 'private', deleteAfterUpload: false, aiService: null, aiKey: null };
}

function saveSchedConfig(cfg) {
  fs.writeFileSync(SCHED_FILE, JSON.stringify(cfg, null, 2));
}

// Save schedule config from frontend
app.post('/api/schedule/save', (req, res) => {
  const cfg = { ...loadSchedConfig(), ...req.body };
  saveSchedConfig(cfg);
  if (cfg.enabled) startServerScheduler();
  else stopServerScheduler();
  res.json({ success: true, config: cfg });
});

// Get current schedule config
app.get('/api/schedule/config', (req, res) => {
  res.json(loadSchedConfig());
});

// Manual trigger
app.post('/api/schedule/run-now', async (req, res) => {
  const cfg = { ...loadSchedConfig(), ...req.body };
  const jobId = await triggerAutoUpload(cfg);
  res.json({ jobId });
});

let schedTimer = null;
let lastRunMap = {}; // slot -> date string

function startServerScheduler() {
  stopServerScheduler();
  schedTimer = setInterval(checkServerSchedule, 30000); // check every 30 sec
  checkServerSchedule();
  console.log('[SCHED] Server scheduler started');
}

function stopServerScheduler() {
  if (schedTimer) { clearInterval(schedTimer); schedTimer = null; }
  console.log('[SCHED] Server scheduler stopped');
}

async function checkServerSchedule() {
  const cfg = loadSchedConfig();
  if (!cfg.enabled || !cfg.slots?.length) return;

  // ⚠️ Railway UTC timezone — Bangladesh = UTC+6
  const tzOffset = parseInt(cfg.tzOffset ?? 6); // default Bangladesh +6
  const now = new Date();
  const localNow = new Date(now.getTime() + tzOffset * 60 * 60 * 1000);
  const day = localNow.getUTCDay();
  if (!cfg.days?.includes(day)) return;

  const curH = localNow.getUTCHours();
  const curM = localNow.getUTCMinutes();
  const cur = String(curH).padStart(2,'0') + ':' + String(curM).padStart(2,'0');
  const today = localNow.toUTCString().split(' ').slice(0,4).join(' ');

  console.log('[SCHED] Local time check:', cur, '| UTC:', now.toISOString());

  for (const slot of cfg.slots) {
    if (!slot.on) continue;
    // 2 minute window — 30sec interval miss এড়াতে
    const [sh, sm] = slot.time.split(':').map(Number);
    const slotMin = sh * 60 + sm;
    const curMin = curH * 60 + curM;
    if (Math.abs(curMin - slotMin) > 1) continue;

    const key = slot.time + '_' + today;
    if (lastRunMap[key]) continue;

    lastRunMap[key] = true;
    console.log('[SCHED] Triggering upload for slot:', slot.time, '| Local:', cur);
    await triggerAutoUpload(cfg);
  }
}

async function triggerAutoUpload(cfg) {
  const jobId = createJob();

  (async () => {
    try {
      const fetch = (await import('node-fetch')).default;
      const t = loadTokens();
      const driveToken = t.drive_access_token;
      const ytToken = t.access_token;

      if (!driveToken) throw new Error('Drive সংযুক্ত নয়');
      if (!ytToken) throw new Error('YouTube সংযুক্ত নয়');
      if (!cfg.folderId) throw new Error('Video Folder ID নেই');

      // List videos from Drive
      const q = encodeURIComponent(`'${cfg.folderId}' in parents and trashed=false`);
      const listRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,size)&pageSize=100`, {
        headers: { 'Authorization': `Bearer ${driveToken}` }
      });
      const listData = await listRes.json();
      const allVideos = (listData.files || []).filter(f => f.mimeType?.includes('video') || f.name?.match(/\.(mp4|mov|avi|mkv|webm)$/i));

      if (!allVideos.length) { jobs[jobId] = { status: 'error', error: 'Drive-এ কোনো ভিডিও নেই' }; return; }

      // Shuffle all videos — maxVideos দিয়ে cap করো
      const maxV = parseInt(cfg.maxVideos) || 5;
      const videos = allVideos.sort(() => Math.random() - 0.5).slice(0, maxV);
      console.log(`[SCHED] Total videos available: ${allVideos.length} | Using max: ${maxV}`);

      // Get audio files
      let audioFiles = [];
      if (cfg.audioFolderId) {
        const aq = encodeURIComponent(`'${cfg.audioFolderId}' in parents and trashed=false`);
        const ar = await fetch(`https://www.googleapis.com/drive/v3/files?q=${aq}&fields=files(id,name,mimeType)&pageSize=50`, {
          headers: { 'Authorization': `Bearer ${driveToken}` }
        });
        const ad = await ar.json();
        audioFiles = (ad.files || []).filter(f => f.name?.match(/\.(mp3|m4a|wav|aac|ogg)$/i));
        console.log('[SCHED] Found', audioFiles.length, 'audio files');
      }

      const results = [];

      // ===== HELPER: Get duration via ffprobe =====
      async function getDuration(filePath) {
        try {
          const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`, { timeout: 15000 });
          return parseFloat(stdout.trim()) || 0;
        } catch { return 0; }
      }

      // ===== PROCESS: One upload per audio =====
      // Pick one random audio → collect videos until duration fills up → merge → upload
      if (audioFiles.length === 0) {
        jobs[jobId] = { status: 'error', error: 'Audio Folder-এ কোনো audio নেই' };
        return;
      }

      const tempAllFiles = [];

      try {
        // Pick random audio
        const randomAudio = audioFiles[Math.floor(Math.random() * audioFiles.length)];
        console.log('[SCHED] Audio:', randomAudio.name);

        // Download audio
        const audioDlRes = await fetch(`https://www.googleapis.com/drive/v3/files/${randomAudio.id}?alt=media`, {
          headers: { 'Authorization': `Bearer ${driveToken}` }
        });
        if (!audioDlRes.ok) throw new Error('Audio download failed');
        const audioPath = path.join(TEMP_DIR, `sched_audio_${Date.now()}${path.extname(randomAudio.name)}`);
        await new Promise((resolve, reject) => {
          const fileStream = fs.createWriteStream(audioPath);
          audioDlRes.body.pipe(fileStream);
          audioDlRes.body.on('error', reject);
          fileStream.on('finish', resolve);
        });
        tempAllFiles.push(audioPath);

        const audioDuration = await getDuration(audioPath);
        console.log('[SCHED] Audio duration:', audioDuration, 'sec');
        if (!audioDuration) throw new Error('Audio duration মাপা গেলো না');

        // Shuffle all videos — audio duration পূরণ না হলে repeat করো
        let totalVideoDuration = 0;
        const selectedVideoPaths = [];
        const usedDriveVideoIds = [];

        // maxVideos cap করো — shuffle করে নাও
        const maxV2 = parseInt(cfg.maxVideos) || 5;
        const shuffledVideos = [...allVideos].sort(() => Math.random() - 0.5);
        // প্রতিটা video unique ID দিয়ে deduplicate করো
        const uniqueVideos = Array.from(new Map(shuffledVideos.map(v => [v.id, v])).values());
        console.log(`[SCHED] Unique videos: ${uniqueVideos.length}`);

        let videoPool = uniqueVideos.slice(0, Math.min(maxV2 * 3, uniqueVideos.length));
        const usedVideoIds = new Set();
        let loopCount = 0;
        while (totalVideoDuration < audioDuration && loopCount < 50) {
          if (videoPool.length === 0) {
            // সব use হলে full pool reset — তবে আগেরগুলো শেষে রাখো
            usedVideoIds.clear();
            videoPool = [...uniqueVideos].sort(() => Math.random() - 0.5);
            console.log('[SCHED] Video pool reset');
          }
          const video = videoPool.shift();
          loopCount++;
          if (!video) break;
          // Same video skip (যদি অন্য option থাকে)
          if (usedVideoIds.has(video.id) && videoPool.length > 0) {
            videoPool.push(video);
            continue;
          }
          usedVideoIds.add(video.id);

          // Download video (streaming — RAM সাশ্রয়)
          const dlRes = await fetch(`https://www.googleapis.com/drive/v3/files/${video.id}?alt=media`, {
            headers: { 'Authorization': `Bearer ${driveToken}` }
          });
          if (!dlRes.ok) continue;

          const videoPath = path.join(TEMP_DIR, `sched_v_${Date.now()}_${video.id}.mp4`);
          await new Promise((resolve, reject) => {
            const fileStream = fs.createWriteStream(videoPath);
            dlRes.body.pipe(fileStream);
            dlRes.body.on('error', reject);
            fileStream.on('finish', resolve);
          });
          tempAllFiles.push(videoPath);

          // Mute video
          const mutedPath = path.join(TEMP_DIR, `sched_vm_${Date.now()}.mp4`);
          let workingPath = videoPath;
          try {
            await execAsync(`ffmpeg -i "${videoPath}" -an -c:v copy -y "${mutedPath}"`, { timeout: 60000 });
            tempAllFiles.push(mutedPath);
            workingPath = mutedPath;
          } catch { /* use original if mute fails */ }

          const vDur = await getDuration(workingPath);
          if (!vDur) continue; // skip if can't measure

          totalVideoDuration += vDur;
          console.log('[SCHED] Video:', video.name, vDur.toFixed(2), 'sec | Total:', totalVideoDuration.toFixed(2));

          // If this video makes total exceed audio → trim it to fit exactly
          if (totalVideoDuration > audioDuration) {
            const excess = totalVideoDuration - audioDuration;
            const trimDur = vDur - excess;
            if (trimDur > 0.5) {
              const trimmedPath = path.join(TEMP_DIR, `sched_vt_${Date.now()}.mp4`);
              try {
                await execAsync(`ffmpeg -i "${workingPath}" -t ${trimDur.toFixed(3)} -c:v copy -y "${trimmedPath}"`, { timeout: 60000 });
                tempAllFiles.push(trimmedPath);
                selectedVideoPaths.push(trimmedPath);
                usedDriveVideoIds.push(video.id);
                console.log('[SCHED] Last video trimmed to:', trimDur.toFixed(2), 'sec');
              } catch {
                // trim failed — skip this video, don't add (would exceed audio)
                console.warn('[SCHED] Trim failed, skipping last video');
              }
            }
            // Stop regardless — we've filled the audio duration
            break;
          }

          selectedVideoPaths.push(workingPath);
          usedDriveVideoIds.push(video.id);
        }

        if (!selectedVideoPaths.length) throw new Error('কোনো video process করা গেলো না');
        console.log('[SCHED] Total videos collected:', selectedVideoPaths.length);

        // Concat all videos
        let finalVideoPath;
        if (selectedVideoPaths.length === 1) {
          finalVideoPath = selectedVideoPaths[0];
        } else {
          // Create concat list file
          const concatFile = path.join(TEMP_DIR, `sched_concat_${Date.now()}.txt`);
          fs.writeFileSync(concatFile, selectedVideoPaths.map(p => `file '${p}'`).join('\n'));
          tempAllFiles.push(concatFile);

          finalVideoPath = path.join(TEMP_DIR, `sched_concat_out_${Date.now()}.mp4`);
          await execAsync(`ffmpeg -f concat -safe 0 -i "${concatFile}" -c:v copy -y "${finalVideoPath}"`, { timeout: 120000 });
          tempAllFiles.push(finalVideoPath);
          console.log('[SCHED] Videos concatenated ✓');
        }

        // Merge audio with concatenated video
        const mergedPath = path.join(TEMP_DIR, `sched_final_${Date.now()}.mp4`);
        await execAsync(`ffmpeg -i "${finalVideoPath}" -i "${audioPath}" -map 0:v -map 1:a -c:v copy -c:a aac -shortest -y "${mergedPath}"`, { timeout: 180000 });
        tempAllFiles.push(mergedPath);
        console.log('[SCHED] Final merge done ✓');

        // AI meta — audio filename দেখে title/hashtag/tags
        // Audio filename থেকে clean title বের করো
        // Format: jobId_Title.mp3 → Title
        // বা: AUDIO-2025-08-09.mp3 → পরিষ্কার করো
        // Audio filename: 1773064165163_gke79h47_Title.mp3 → Title
        let rawTitle = randomAudio.name
          .replace(/\.[^.]+$/, '')               // extension বাদ
          .replace(/^[\d]+_[a-z0-9]+_/i, '')     // jobId_hash_ prefix বাদ
          .replace(/^[\d]+_/, '')                // numeric_ prefix বাদ
          .replace(/^[a-z0-9]{6,}_/i, '')        // hash_ prefix বাদ
          .replace(/[_]/g, ' ')                  // underscore → space
          .replace(/^-+/, '')                    // leading dash বাদ
          .replace(/\d{4}-\d{2}-\d{2}.*$/, '') // date suffix বাদ
          .replace(/AUDIO/gi, '')                // "AUDIO" word বাদ
          .replace(/^[-\d\s:]+$/, '')           // শুধু date/number হলে empty
          .replace(/\s+/g, ' ')                 // extra space বাদ
          .trim() || 'ইসলামিক ওয়াজ';

        // ===== Full Fallback (AI fail হলেও এটা use হবে) =====
        const fallbackHashtags = [
          '#shorts','#islamicshorts','#waz','#islamicvideo','#quran',
          '#allah','#islam','#muslim','#bangla','#bangladesh',
          '#viral','#islamicmotivation','#deen','#alhamdulillah','#subhanallah',
          '#islamiccontent','#islamicquotes','#hadith','#sunnah','#namaz'
        ];
        const fallbackTags = [
          'islamic shorts','bangla waz','islamic motivation','quran','allah',
          'muslim','bangladesh','viral islamic','waz mahfil','islamic video bangla',
          'deen','hadith','sunnah','islamic quotes','bangla islamic video',
          'ওয়াজ','ইসলামিক শর্টস','বাংলা ওয়াজ','ইসলামিক মোটিভেশন','quran recitation',
          'islamic reminder','allah akbar','subhanallah','alhamdulillah','short islamic video'
        ];
        const fallbackTitleOptions = [
          `☪️ ${rawTitle} | বাংলা ইসলামিক শর্টস`,
          `🤲 ${rawTitle} | ইসলামিক মোটিভেশন`,
          `📿 ${rawTitle} | ওয়াজ মাহফিল`,
          `🕌 ${rawTitle} | বাংলা ওয়াজ`,
          `✨ ${rawTitle} | ইসলামিক ভিডিও`,
        ];
        const fallbackDesc = `আল্লাহর পথে থাকুন, সঠিক পথ বেছে নিন।\nইসলামের আলোয় জীবন সাজান।\nআল্লাহু আকবার ☪️ | সূরা ও হাদিসের আলোকে।`;

        let meta = {
          title: fallbackTitleOptions[Math.floor(Math.random() * fallbackTitleOptions.length)].substring(0, 100),
          description: fallbackDesc,
          hashtags: fallbackHashtags,
          tags: fallbackTags
        };

        if (cfg.aiService && cfg.aiKey) {
          try {
            const prompt = `You are an expert Islamic YouTube Shorts content creator for a Bengali audience. The audio file name is: "${title}" (this is the WAZ/MOTIVATION audio title - base your content on this). STRICT RULES: 1) Return ONLY valid JSON, zero explanation, zero markdown backticks. 2) Title: Bengali, emotional/motivational, emoji-rich (☪️🤲📿🕌✨), max 60 chars, inspired by the audio filename meaning. 3) Description: 3 lines Bengali Islamic motivation ending with relevant duas/ayat reference. 4) Hashtags: Mix HIGH volume + NICHE tags. Use these proven viral Islamic hashtags: #shorts #islamicshorts #waz #islamicvideo #quran #allah #islam #muslim #bangla #bangladesh #viral #islamicmotivation #deen #alhamdulillah #subhanallah — then add 5 more relevant to the audio topic. Total exactly 20 hashtags. 5) Tags: Include both Bengali phonetic + English SEO tags. Must include: islamic shorts, bangla waz, islamic motivation, quran, allah, muslim, bangladesh, viral islamic, waz mahfil, islamic video bangla, deen, hadith, sunnah, islamic quotes — then add topic-specific tags. Total exactly 25 tags. Return exactly: {"title":"বাংলা ইসলামিক টাইটেল ☪️","description":"লাইন ১\nলাইন ২\nলাইন ৩","hashtags":["#shorts",...exactly 20],"tags":["islamic shorts",...exactly 25]}`;
            let aiText = '';
            if (cfg.aiService === 'gemini') {
              const ar = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${cfg.aiKey}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
              });
              aiText = (await ar.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
            } else if (cfg.aiService === 'groq') {
              const ar = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.aiKey}` },
                body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 800 })
              });
              aiText = (await ar.json()).choices?.[0]?.message?.content || '';
            } else if (cfg.aiService === 'grok') {
              const ar = await fetch('https://api.x.ai/v1/chat/completions', {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.aiKey}` },
                body: JSON.stringify({ model: 'grok-3-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 800 })
              });
              aiText = (await ar.json()).choices?.[0]?.message?.content || '';
            }
            if (aiText) {
              // Clean bad control characters before parsing
              const cleanText = aiText
                .replace(/```json\n?/g,'').replace(/```\n?/g,'')
                .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // remove bad control chars
                .replace(/\n/g, '\\n') // escape literal newlines inside strings
                .trim();
              // Extract JSON object only
              const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
              const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleanText);
              // AI সফল হলে replace করো — কিন্তু empty field হলে fallback রাখো
              meta = {
                title: parsed.title || meta.title,
                description: parsed.description || meta.description,
                hashtags: (parsed.hashtags?.length >= 10) ? parsed.hashtags : meta.hashtags,
                tags: (parsed.tags?.length >= 10) ? parsed.tags : meta.tags
              };
              console.log('[SCHED] AI meta generated ✓');
            }
          } catch(e) {
            console.warn('[SCHED] AI failed, using fallback:', e.message);
          }
        }

        // Upload YouTube
        const fullDesc = `${meta.description || ''}\n\n${(meta.hashtags || []).join(' ')}`.trim();
        const ytMeta = {
          snippet: { title: (meta.title || rawTitle).substring(0, 100), description: fullDesc.substring(0, 5000), tags: (meta.tags || []).slice(0, 30), categoryId: '22' },
          status: { privacyStatus: cfg.privacy || 'private', selfDeclaredMadeForKids: false }
        };

        const fileSize = fs.statSync(mergedPath).size;
        const initRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${ytToken}`, 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': fileSize },
          body: JSON.stringify(ytMeta)
        });
        if (!initRes.ok) throw new Error('YT init: ' + await initRes.text());

        const uploadUrl = initRes.headers.get('location');
        const videoBuf = fs.readFileSync(mergedPath);
        const upRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'video/mp4', 'Content-Length': videoBuf.length },
          body: videoBuf
        });
        if (!upRes.ok) throw new Error('YT upload: ' + await upRes.text());
        const ytData = await upRes.json();

        // Delete used videos from Drive
        if (cfg.deleteAfterUpload) {
          for (const videoId of usedDriveVideoIds) {
            try {
              await fetch(`https://www.googleapis.com/drive/v3/files/${videoId}`, {
                method: 'DELETE', headers: { 'Authorization': `Bearer ${driveToken}` }
              });
              console.log('[SCHED] Deleted from Drive:', videoId);
            } catch {}
          }
        }

        // Cleanup temp
        tempAllFiles.forEach(f => { try { if(fs.existsSync(f)) fs.unlinkSync(f); } catch {} });

        results.push({ audioFile: randomAudio.name, videoCount: selectedVideoPaths.length, videoId: ytData.id, url: `https://youtu.be/${ytData.id}`, title: meta.title, status: 'ok' });
        console.log('[SCHED] Uploaded:', ytData.id, '| Videos used:', selectedVideoPaths.length);

      } catch(err) {
        tempAllFiles.forEach(f => { try { if(fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
        results.push({ error: err.message, status: 'error' });
        console.error('[SCHED] Error:', err.message);
      }

      jobs[jobId] = { status: 'done', result: { total: videos.length, results } };
      console.log('[SCHED] Done!', results.filter(r=>r.status==='ok').length, '/', videos.length, 'uploaded');

    } catch(err) {
      console.error('[SCHED] Fatal:', err.message);
      jobs[jobId] = { status: 'error', error: err.message };
    }
  })();

  return jobId;
}


// ========== CHANNEL SHORTS SCRAPER ==========
app.post('/api/channel/shorts', async (req, res) => {
  const { channelUrl, maxLinks = 50 } = req.body;
  if (!channelUrl) return res.status(400).json({ error: 'Channel URL দিন' });

  try {
    let channelArg = channelUrl.trim();

    // yt-dlp দিয়ে channel-এর shorts list করো (async — event loop block হবে না)
    const maxP = Math.min(parseInt(maxLinks) || 50, 200);
    const cmd = `yt-dlp --flat-playlist --playlist-end ${maxP} --print "%(url)s|%(title)s|%(duration)s" "${channelArg}/shorts"`;

    let output = '';
    try {
      const result = await execAsync(cmd, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
      output = result.stdout || '';
    } catch(e) {
      output = e.stdout?.toString() || '';
    }

    const links = [];
    output.split('\n').filter(Boolean).forEach(line => {
      const parts = line.split('|');
      const url = parts[0]?.trim();
      const title = parts[1]?.trim() || '';
      const duration = parseInt(parts[2]) || 0;
      if (url && url.includes('youtube') || url?.startsWith('http')) {
        // Shorts = 60 sec বা কম
        if (duration <= 60 || duration === 0) {
          const ytUrl = url.includes('youtube.com') || url.includes('youtu.be') 
            ? url 
            : `https://www.youtube.com/shorts/${url}`;
          links.push({ url: ytUrl, title, duration });
        }
      }
    });

    if (!links.length) {
      // Fallback: /shorts endpoint try করো
      try {
        const cmd2 = `yt-dlp --flat-playlist --playlist-end ${Math.min(parseInt(maxLinks) || 50, 200)} --print "%(url)s|%(title)s|%(duration)s" "${channelArg}/shorts" 2>/dev/null`;
        const out2 = execSync(cmd2, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }).toString();
        out2.split('\n').filter(Boolean).forEach(line => {
          const parts = line.split('|');
          const url = parts[0]?.trim();
          const title = parts[1]?.trim() || '';
          if (url) links.push({ url: url.startsWith('http') ? url : `https://www.youtube.com/shorts/${url}`, title, duration: 0 });
        });
      } catch {}
    }

    res.json({ links, total: links.length });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});


// ========== DRIVE UPLOAD FROM SERVER PATH ==========
app.post('/api/drive/upload-to-folder', async (req, res) => {
  const { filePath, fileName, folderId, driveToken } = req.body;
  if (!filePath || !folderId) return res.status(400).json({ error: 'filePath and folderId required' });
  if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'File not found: ' + filePath });

  try {
    const fetch = (await import('node-fetch')).default;
    const t = loadTokens();
    const token = driveToken || t.drive_access_token || process.env.DRIVE_ACCESS_TOKEN;
    if (!token) throw new Error('Drive token নেই');

    const mime = fileName?.match(/\.(mp3|m4a|wav|aac|ogg)$/i) ? 'audio/mpeg' : 'video/mp4';
    const fileSize = fs.statSync(filePath).size;

    // Resumable upload init
    const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': mime,
        'X-Upload-Content-Length': fileSize
      },
      body: JSON.stringify({ name: fileName || path.basename(filePath), parents: [folderId] })
    });
    if (!initRes.ok) throw new Error('Drive init failed: ' + await initRes.text());
    const uploadUrl = initRes.headers.get('location');

    // Streaming upload — RAM সাশ্রয়
    const fileStream = fs.createReadStream(filePath);
    const upRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': mime, 'Content-Length': fileSize },
      body: fileStream
    });
    if (!upRes.ok) throw new Error('Drive upload failed: ' + await upRes.text());
    const data = await upRes.json();

    // Cleanup temp file
    try { fs.unlinkSync(filePath); } catch {}

    res.json({ success: true, fileId: data.id, name: data.name });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== SSE LIVE LOG ==========
const sseClients = new Set();

// Override console.log to broadcast to SSE clients
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

function broadcastLog(msg) {
  const data = JSON.stringify({ msg, time: new Date().toISOString() });
  sseClients.forEach(res => {
    try { res.write(`data: ${data}\n\n`); } catch {}
  });
}

console.log = (...args) => { origLog(...args); broadcastLog(args.join(' ')); };
console.warn = (...args) => { origWarn(...args); broadcastLog('⚠️ ' + args.join(' ')); };
console.error = (...args) => { origError(...args); broadcastLog('❌ ' + args.join(' ')); };

app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.write('data: {"msg":"✅ Live log connected","time":"' + new Date().toISOString() + '"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ========== START ==========
app.listen(PORT, () => {
  console.log(`🚀 YouTube Automation Server running on port ${PORT}`);
  try { require('child_process').execSync('yt-dlp --version'); console.log('✓ yt-dlp available'); } catch { console.warn('✗ yt-dlp not found'); }
  try { require('child_process').execSync('ffmpeg -version 2>&1 | head -1'); console.log('✓ ffmpeg available'); } catch { console.warn('✗ ffmpeg not found'); }

  // Auto-start scheduler if was enabled
  const cfg = loadSchedConfig();
  if (cfg.enabled) {
    console.log('[SCHED] Auto-starting scheduler from saved config...');
    startServerScheduler();
  }
});

// ========== DRIVE AUTO UPLOAD SYSTEM ==========


// Drive token for direct browser upload
app.get('/api/drive/token', (req, res) => {
  const t = loadTokens();
  if (!t.drive_access_token) return res.status(401).json({ error: 'Drive সংযুক্ত নয়' });
  res.json({ token: t.drive_access_token });
});


app.post('/api/drive/upload-video', upload.single('video'), async (req, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const t = loadTokens();
    const driveToken = t.drive_access_token;
    if (!driveToken) throw new Error('Drive সংযুক্ত নয়');

    const folderId = req.body.folderId;
    if (!folderId) throw new Error('Folder ID নেই');

    const file = req.file;
    if (!file) throw new Error('ফাইল পাওয়া যায়নি');

    const fileName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const fileBuffer = fs.readFileSync(file.path);
    const mimeType = file.mimetype || 'video/mp4';

    // Upload to Drive multipart
    const metadata = { name: fileName, parents: [folderId] };
    const boundary = 'vid_boundary_' + Date.now();
    const metaPart = Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n`);
    const dataPart = Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const endPart = Buffer.from(`\r\n--${boundary}--`);
    const body = Buffer.concat([metaPart, dataPart, fileBuffer, endPart]);

    const upRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${driveToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': body.length
      },
      body
    });
    const upData = await upRes.json();

    // Cleanup temp
    try { fs.unlinkSync(file.path); } catch {}

    if (!upData.id) throw new Error(upData.error?.message || 'Upload failed');
    res.json({ success: true, fileId: upData.id, fileName });
  } catch(err) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save downloaded audio to Drive Audio Folder
app.post('/api/drive/save-audio', async (req, res) => {
  const { filePath, fileName, audioFolderId } = req.body;
  try {
    const fetch = (await import('node-fetch')).default;
    const t = loadTokens();
    const driveToken = t.drive_access_token;
    if (!driveToken) throw new Error('Drive সংযুক্ত নয়');
    if (!audioFolderId) throw new Error('Audio Folder ID নেই');

    // Find the actual file
    let actualPath = filePath;
    if (!actualPath || !fs.existsSync(actualPath)) {
      // Search in TEMP_DIR
      const files = fs.readdirSync(TEMP_DIR).filter(f => f.match(/\.(mp3|m4a|wav|aac|ogg|opus)$/i));
      if (!files.length) throw new Error('Audio ফাইল পাওয়া গেলো না');
      // Get most recent
      actualPath = path.join(TEMP_DIR, files.sort((a, b) => {
        return fs.statSync(path.join(TEMP_DIR, b)).mtime - fs.statSync(path.join(TEMP_DIR, a)).mtime;
      })[0]);
    }

    const fileBuffer = fs.readFileSync(actualPath);
    const ext = path.extname(actualPath) || '.mp3';
    const cleanName = (fileName || path.basename(actualPath)).replace(/[^\w\s\u0980-\u09FF.-]/g, '').trim() + (fileName?.includes('.') ? '' : ext);
    const mimeType = ext === '.mp3' ? 'audio/mpeg' : ext === '.m4a' ? 'audio/mp4' : ext === '.wav' ? 'audio/wav' : 'audio/mpeg';

    // Upload to Drive
    const metadata = { name: cleanName, parents: [audioFolderId] };
    const boundary = 'audio_boundary_' + Date.now();
    const metaPart = Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n`);
    const dataPart = Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const endPart = Buffer.from(`\r\n--${boundary}--`);
    const body = Buffer.concat([metaPart, dataPart, fileBuffer, endPart]);

    const upRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${driveToken}`, 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': body.length },
      body
    });
    const upData = await upRes.json();
    if (!upData.id) throw new Error(upData.error?.message || 'Upload failed');

    // Cleanup temp file
    try { fs.unlinkSync(actualPath); } catch {}

    res.json({ success: true, fileId: upData.id, fileName: cleanName });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// List files in Drive folder
app.get('/api/drive/list', async (req, res) => {
  const { folderId } = req.query;
  try {
    const fetch = (await import('node-fetch')).default;
    const t = loadTokens();
    const token = t.drive_access_token || process.env.DRIVE_ACCESS_TOKEN;
    if (!token) throw new Error('Drive সংযুক্ত নয়');

    const query = folderId
      ? `'${folderId}' in parents and trashed=false`
      : `trashed=false`;

    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,size)&pageSize=100`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const data = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(data));
    res.json({ files: data.files || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download file from Drive to temp
app.post('/api/drive/download', async (req, res) => {
  const { fileId, fileName } = req.body;
  try {
    const fetch = (await import('node-fetch')).default;
    const t = loadTokens();
    const token = t.drive_access_token || process.env.DRIVE_ACCESS_TOKEN;
    if (!token) throw new Error('Drive সংযুক্ত নয়');

    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!r.ok) throw new Error('Drive download failed');

    const localPath = path.join(TEMP_DIR, fileName || fileId + '.mp4');
    const buffer = await r.buffer();
    fs.writeFileSync(localPath, buffer);

    res.json({ success: true, filepath: localPath, filename: path.basename(localPath) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete file from Drive
app.post('/api/drive/delete', async (req, res) => {
  const { fileId } = req.body;
  try {
    const fetch = (await import('node-fetch')).default;
    const t = loadTokens();
    const token = t.drive_access_token || process.env.DRIVE_ACCESS_TOKEN;
    if (!token) throw new Error('Drive সংযুক্ত নয়');

    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}`,
      { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!r.ok && r.status !== 204) throw new Error('Delete failed');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full auto: Drive video folder + audio folder → merge → AI meta → YouTube → delete
app.post('/api/drive/auto-upload', async (req, res) => {
  const { folderId, audioFolderId, aiService, aiKey, privacy, deleteAfterUpload, maxVideos } = req.body;

  const jobId = createJob();
  res.json({ jobId, status: 'processing' });

  (async () => {
    try {
      const fetch = (await import('node-fetch')).default;
      const t = loadTokens();
      const driveToken = t.drive_access_token || process.env.DRIVE_ACCESS_TOKEN;
      const ytToken = t.access_token || process.env.YT_ACCESS_TOKEN;

      if (!driveToken) throw new Error('Drive সংযুক্ত নয়');
      if (!ytToken) throw new Error('YouTube সংযুক্ত নয়');

      // Helper: list Drive folder
      async function listDriveFolder(fid, mimeFilter) {
        const q = `'${fid}' in parents and trashed=false`;
        const r = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size)&pageSize=100`,
          { headers: { 'Authorization': `Bearer ${driveToken}` } }
        );
        const d = await r.json();
        const files = d.files || [];
        return mimeFilter ? files.filter(f => (typeof mimeFilter === "string" ? f.mimeType?.includes(mimeFilter) : f.mimeType?.match(mimeFilter)) || f.name?.match(mimeFilter)) : files;
      }

      // Helper: download from Drive
      async function downloadFromDrive(fileId, fileName) {
        const r = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
          { headers: { 'Authorization': `Bearer ${driveToken}` } }
        );
        if (!r.ok) throw new Error('Drive download failed: ' + fileName);
        const localPath = path.join(TEMP_DIR, fileId + '_' + fileName);
        const buffer = await r.buffer();
        fs.writeFileSync(localPath, buffer);
        return localPath;
      }

      // Helper: delete from Drive
      async function deleteFromDrive(fileId) {
        await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
          method: 'DELETE', headers: { 'Authorization': `Bearer ${driveToken}` }
        });
      }

      // Helper: generate AI meta
      async function generateMeta(title) {
        if (!aiService || !aiKey) return { title, description: '', hashtags: [], tags: [] };
        const prompt = `You are an expert Islamic YouTube Shorts content creator for a Bengali audience. The audio file name is: "${rawTitle}" (this is the WAZ/MOTIVATION audio title - base your content on this). STRICT RULES: 1) Return ONLY valid JSON, zero explanation, zero markdown backticks. 2) Title: Bengali, emotional/motivational, emoji-rich (☪️🤲📿🕌✨), max 60 chars, inspired by the audio filename meaning. 3) Description: 3 lines Bengali Islamic motivation ending with relevant duas/ayat reference. 4) Hashtags: Mix HIGH volume + NICHE tags. Use these proven viral Islamic hashtags: #shorts #islamicshorts #waz #islamicvideo #quran #allah #islam #muslim #bangla #bangladesh #viral #islamicmotivation #deen #alhamdulillah #subhanallah — then add 5 more relevant to the audio topic. Total exactly 20 hashtags. 5) Tags: Include both Bengali phonetic + English SEO tags. Must include: islamic shorts, bangla waz, islamic motivation, quran, allah, muslim, bangladesh, viral islamic, waz mahfil, islamic video bangla, deen, hadith, sunnah, islamic quotes — then add topic-specific tags. Total exactly 25 tags. Return exactly: {"title":"বাংলা ইসলামিক টাইটেল ☪️","description":"লাইন ১
লাইন ২
লাইন ৩","hashtags":["#shorts",...exactly 20],"tags":["islamic shorts",...exactly 25]}`;
        let aiText = '';
        if (aiService === 'gemini') {
          const ar = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${aiKey}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
          });
          const ad = await ar.json();
          aiText = ad.candidates?.[0]?.content?.parts?.[0]?.text || '';
        } else if (aiService === 'grok') {
          const ar = await fetch('https://api.x.ai/v1/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiKey}` },
            body: JSON.stringify({ model: 'grok-3-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 800 })
          });
          const ad = await ar.json();
          aiText = ad.choices?.[0]?.message?.content || '';
        } else if (aiService === 'openai') {
          const ar = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiKey}` },
            body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 800 })
          });
          const ad = await ar.json();
          aiText = ad.choices?.[0]?.message?.content || '';
        }
        try {
          const clean = aiText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          return JSON.parse(clean);
        } catch { return { title, description: '', hashtags: [], tags: [] }; }
      }

      // 1. List videos from Drive
      console.log('[AUTO] Listing videos from Drive folder:', folderId);
      const allVideos = await listDriveFolder(folderId, /\.(mp4|mov|avi|mkv|webm)$/i);
      if (!allVideos.length) throw new Error('Drive ভিডিও ফোল্ডারে কোনো ভিডিও নেই');

      // Shuffle and limit
      const shuffled = allVideos.sort(() => Math.random() - 0.5);
      const videos = maxVideos ? shuffled.slice(0, maxVideos) : shuffled;
      console.log('[AUTO] Found', allVideos.length, 'videos, processing', videos.length);

      // 2. List audios from Drive audio folder (if provided)
      let audioFiles = [];
      if (audioFolderId) {
        audioFiles = await listDriveFolder(audioFolderId, /\.(mp3|m4a|wav|aac|ogg)$/i);
        console.log('[AUTO] Found', audioFiles.length, 'audio files');
      }

      const results = [];

      for (const video of videos) {
        console.log('[AUTO] Processing:', video.name);
        const tempFiles = [];

        try {
          // 3. Download video
          const videoPath = await downloadFromDrive(video.id, video.name);
          tempFiles.push(videoPath);

          let finalVideoPath = videoPath;

          // 4. Pick random audio and merge
          if (audioFiles.length > 0) {
            const randomAudio = audioFiles[Math.floor(Math.random() * audioFiles.length)];
            console.log('[AUTO] Using audio:', randomAudio.name);
            const audioPath = await downloadFromDrive(randomAudio.id, randomAudio.name);
            tempFiles.push(audioPath);

            // Mute original + merge audio
            const mergedPath = path.join(TEMP_DIR, 'merged_' + Date.now() + '.mp4');
            tempFiles.push(mergedPath);
            await execAsync(
              `ffmpeg -i "${videoPath}" -stream_loop -1 -i "${audioPath}" -map 0:v -map 1:a -c:v copy -c:a aac -shortest -y "${mergedPath}"`,
              { timeout: 120000 }
            );
            finalVideoPath = mergedPath;
            console.log('[AUTO] Audio merged ✓');
          }

          // 5. Generate AI meta
          const videoTitle = video.name.replace(/\.[^.]+$/, '');
          const meta = await generateMeta(videoTitle);
          console.log('[AUTO] AI meta:', meta.title);

          // 6. Upload to YouTube
          const fullDesc = `${meta.description || ''}\n\n${(meta.hashtags || []).join(' ')}`.trim();
          const ytMeta = {
            snippet: {
              title: (meta.title || videoTitle).substring(0, 100),
              description: fullDesc.substring(0, 5000),
              tags: (meta.tags || []).slice(0, 30),
              categoryId: '22'
            },
            status: { privacyStatus: privacy || 'private', selfDeclaredMadeForKids: false }
          };

          const fileSize = fs.statSync(finalVideoPath).size;
          const initRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${ytToken}`,
              'Content-Type': 'application/json',
              'X-Upload-Content-Type': 'video/mp4',
              'X-Upload-Content-Length': fileSize
            },
            body: JSON.stringify(ytMeta)
          });
          if (!initRes.ok) throw new Error('YT init failed: ' + await initRes.text());

          const uploadUrl = initRes.headers.get('location');
          const videoBuf = fs.readFileSync(finalVideoPath);
          const upRes = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'video/mp4', 'Content-Length': videoBuf.length },
            body: videoBuf
          });
          if (!upRes.ok) throw new Error('YT upload failed: ' + await upRes.text());
          const ytData = await upRes.json();
          console.log('[AUTO] Uploaded to YouTube:', ytData.id);

          // 7. Cleanup temp files
          tempFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });

          // 8. Delete from Drive if needed
          if (deleteAfterUpload) {
            await deleteFromDrive(video.id);
            console.log('[AUTO] Deleted from Drive:', video.name);
          }

          results.push({ file: video.name, videoId: ytData.id, url: `https://youtu.be/${ytData.id}`, title: meta.title, status: 'ok' });

        } catch (fileErr) {
          console.error('[AUTO] Error:', video.name, fileErr.message);
          tempFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
          results.push({ file: video.name, error: fileErr.message, status: 'error' });
        }

        // 3 second delay between uploads
        await new Promise(r => setTimeout(r, 3000));
      }

      jobs[jobId] = { status: 'done', result: { success: true, total: videos.length, results } };
      console.log('[AUTO] All done!', results.filter(r => r.status === 'ok').length, '/', videos.length, 'uploaded');

    } catch (err) {
      console.error('[AUTO] Fatal:', err.message);
      jobs[jobId] = { status: 'error', error: err.message };
    }
  })();
});

// ========== KUAISHOU DOWNLOADER (HTML scraping) ==========
app.post('/api/kuaishou/download', async (req, res) => {
  const { url, mute = true } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const jobId = createJob();
  res.json({ jobId, status: 'processing' });

  (async () => {
    try {
      const fetch = (await import('node-fetch')).default;

      // Step 1: Resolve short URL and get full page HTML
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://www.kuaishou.com/'
      };

      const pageRes = await fetch(url, { redirect: 'follow', headers });
      const finalUrl = pageRes.url;
      const html = await pageRes.text();
      console.log('[KS] Final URL:', finalUrl);

      // Step 2: Extract video URL from HTML
      let videoUrl = null;
      let title = 'Kuaishou_video';
      let thumbnail = null;

      // Extract photoId from URL
      const photoIdMatch = finalUrl.match(/featured\/(\w+)/) || finalUrl.match(/photoId=([a-zA-Z0-9_-]+)/);
      if (photoIdMatch) {
        const photoId = photoIdMatch[1];
        console.log('[KS] photoId:', photoId);

        // Use working GraphQL endpoint (video.kuaishou.com)
        try {
          const gqlRes = await fetch("https://video.kuaishou.com/graphql", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              operationName: "visionVideoDetail",
              variables: { photoId, page: "selected" },
              query: "query visionVideoDetail($photoId: String, $type: String, $page: String) { visionVideoDetail(photoId: $photoId, type: $type, page: $page) { photo { id caption coverUrl photoUrl } } }"
            })
          });
          const gqlData = await gqlRes.json();
          console.log('[KS] GraphQL:', JSON.stringify(gqlData).substring(0, 200));
          const photo = gqlData?.data?.visionVideoDetail?.photo;
          if (photo?.photoUrl) {
            videoUrl = photo.photoUrl;
            title = (photo.caption || photoId).replace(/\n/g, '').trim();
            thumbnail = photo.coverUrl || null;
          }
        } catch (e) { console.warn('[KS] GraphQL error:', e.message); }
      }

      // Fallback: try HTML patterns
      if (!videoUrl) {
        const patterns = [
          /"photoUrl"\s*:\s*"([^"]+)"/,
          /"url"\s*:\s*"(https:\/\/[^"]*\.mp4[^"]*)"/,
          /<video[^>]+src="([^"]+)"/,
        ];
        for (const p of patterns) {
          const m = html.match(p);
          if (m && m[1].includes('mp4')) {
            videoUrl = m[1].replace(/\\u002F/g, '/').replace(/\\/g, '');
            break;
          }
        }
      }

      const titleM = html.match(/"caption"\s*:\s*"([^"]+)"/) || html.match(/<title>([^<]+)<\/title>/);
      if (titleM && !title) title = titleM[1].replace(/\s*[-|].*$/, '').trim();

      if (!videoUrl) throw new Error('Video URL বের করা গেলো না। Video private বা region blocked হতে পারে।');

      // Step 3: Download video
      console.log('[KS] Downloading video:', videoUrl.substring(0, 80));
      const vidRes = await fetch(videoUrl, {
        headers: { 'User-Agent': headers['User-Agent'], 'Referer': 'https://www.kuaishou.com/' }
      });
      if (!vidRes.ok) throw new Error('Video download failed: HTTP ' + vidRes.status);

      const outPath = path.join(TEMP_DIR, `ks_${jobId}.mp4`);
      const buffer = await vidRes.buffer();
      fs.writeFileSync(outPath, buffer);

      // Step 4: Mute
      let finalPath = outPath;
      if (mute) {
        const mutedPath = path.join(TEMP_DIR, `ks_muted_${jobId}.mp4`);
        await execAsync(`ffmpeg -i "${outPath}" -an -c:v copy -y "${mutedPath}"`, { timeout: 60000 });
        fs.unlinkSync(outPath);
        finalPath = mutedPath;
      }

      const stat = fs.statSync(finalPath);
      jobs[jobId] = {
        status: 'done',
        result: {
          title: title.substring(0, 100),
          filename: path.basename(finalPath),
          filepath: finalPath,
          thumbnail,
          size: (stat.size / 1024 / 1024).toFixed(1) + 'MB',
          source: 'kuaishou'
        }
      };
      console.log('[KS] Done:', title);

    } catch (err) {
      console.error('[KS]', err.message);
      jobs[jobId] = { status: 'error', error: err.message };
    }
  })();
});



// Bulk Kuaishou download
app.post('/api/kuaishou/bulk', async (req, res) => {
  const { urls, mute = true } = req.body;
  if (!urls?.length) return res.status(400).json({ error: 'URLs required' });

  const jobId = createJob();
  res.json({ jobId, status: 'processing' });

  (async () => {
    const results = [];
    for (const url of urls) {
      try {
        const fetch = (await import('node-fetch')).default;
        let photoId = null;
        const m = url.match(/short-video\/([a-zA-Z0-9_-]+)/);
        if (m) photoId = m[1];
        if (!photoId) {
          const redir = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
          const fm = redir.url.match(/short-video\/([a-zA-Z0-9_-]+)/);
          if (fm) photoId = fm[1];
        }
        if (!photoId) throw new Error('ID বের হলো না');

        const gqlRes = await fetch('https://www.kuaishou.com/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.kuaishou.com/' },
          body: JSON.stringify({
            operationName: 'visionVideoDetail',
            variables: { photoId, page: 'selected' },
            query: `query visionVideoDetail($photoId: String, $type: String, $page: String) { visionVideoDetail(photoId: $photoId, type: $type, page: $page) { photo { id caption coverUrl photoUrl } } }`
          })
        });
        const gqlData = await gqlRes.json();
        const photo = gqlData?.data?.visionVideoDetail?.photo;
        if (!photo?.photoUrl) throw new Error('Video URL নেই');

        const outPath = path.join(TEMP_DIR, `ks_bulk_${Date.now()}.mp4`);
        const vidRes = await fetch(photo.photoUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const buf = await vidRes.buffer();
        fs.writeFileSync(outPath, buf);

        let finalPath = outPath;
        if (mute) {
          const mp = path.join(TEMP_DIR, `ks_m_${Date.now()}.mp4`);
          await execAsync(`ffmpeg -i "${outPath}" -an -c:v copy -y "${mp}"`, { timeout: 60000 });
          fs.unlinkSync(outPath);
          finalPath = mp;
        }

        const stat = fs.statSync(finalPath);
        results.push({ url, title: photo.caption || photoId, filename: path.basename(finalPath), filepath: finalPath, thumbnail: photo.coverUrl, size: (stat.size/1024/1024).toFixed(1)+'MB', status: 'ok' });
      } catch (e) {
        results.push({ url, error: e.message, status: 'error' });
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    jobs[jobId] = { status: 'done', result: { results } };
  })();
});

// ========== ZIP EXTRACT + PROCESS ==========
// Drive-এ ZIP upload করলে extract করে video process করবে
app.post('/api/drive/zip-upload', async (req, res) => {
  const { fileId, fileName, audioFolderId, aiService, aiKey, privacy, deleteAfterUpload } = req.body;
  if (!fileId) return res.status(400).json({ error: 'fileId required' });

  const jobId = createJob();
  res.json({ jobId, status: 'processing' });

  (async () => {
    const tempFiles = [];
    try {
      const fetch = (await import('node-fetch')).default;
      const t = loadTokens();
      const driveToken = t.drive_access_token;
      const ytToken = t.access_token;
      if (!driveToken) throw new Error('Drive সংযুক্ত নয়');
      if (!ytToken) throw new Error('YouTube সংযুক্ত নয়');

      // 1. Download ZIP from Drive
      console.log('[ZIP] Downloading ZIP from Drive:', fileId);
      const dlRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { 'Authorization': `Bearer ${driveToken}` }
      });
      if (!dlRes.ok) throw new Error('ZIP download failed: ' + dlRes.status);

      const zipPath = path.join(TEMP_DIR, `zip_${jobId}.zip`);
      const buf = await dlRes.buffer();
      fs.writeFileSync(zipPath, buf);
      tempFiles.push(zipPath);
      console.log('[ZIP] Downloaded:', (buf.length / 1024 / 1024).toFixed(1) + 'MB');

      // 2. Extract ZIP
      const extractDir = path.join(TEMP_DIR, `zip_extracted_${jobId}`);
      fs.mkdirSync(extractDir, { recursive: true });
      tempFiles.push(extractDir);

      await execAsync(`unzip -o "${zipPath}" -d "${extractDir}"`, { timeout: 120000 });
      console.log('[ZIP] Extracted to:', extractDir);

      // 3. Find all video files
      const { stdout } = await execAsync(`find "${extractDir}" -type f \\( -name "*.mp4" -o -name "*.mov" -o -name "*.avi" -o -name "*.mkv" -o -name "*.webm" \\)`);
      const videoFiles = stdout.trim().split('\n').filter(Boolean);
      console.log('[ZIP] Found', videoFiles.length, 'videos');

      if (!videoFiles.length) throw new Error('ZIP-এ কোনো ভিডিও নেই');

      // 4. Get audio files from Drive if audioFolderId provided
      let audioFiles = [];
      if (audioFolderId) {
        const aq = encodeURIComponent(`'${audioFolderId}' in parents and trashed=false`);
        const ar = await fetch(`https://www.googleapis.com/drive/v3/files?q=${aq}&fields=files(id,name,mimeType)&pageSize=50`, {
          headers: { 'Authorization': `Bearer ${driveToken}` }
        });
        const ad = await ar.json();
        audioFiles = (ad.files || []).filter(f => f.name?.match(/\.(mp3|m4a|wav|aac|ogg)$/i));
        console.log('[ZIP] Found', audioFiles.length, 'audio files in Drive');
      }

      // 5. Process each video
      const results = [];
      for (const videoPath of videoFiles) {
        const videoName = path.basename(videoPath);
        const videoTemp = [];
        console.log('[ZIP] Processing:', videoName);

        try {
          let finalVideoPath = videoPath;

          // Merge random audio if available
          if (audioFiles.length > 0) {
            const randomAudio = audioFiles[Math.floor(Math.random() * audioFiles.length)];
            
            // Download audio from Drive
            const audioDlRes = await fetch(`https://www.googleapis.com/drive/v3/files/${randomAudio.id}?alt=media`, {
              headers: { 'Authorization': `Bearer ${driveToken}` }
            });
            const audioPath = path.join(TEMP_DIR, `audio_${jobId}_${Date.now()}${path.extname(randomAudio.name)}`);
            fs.writeFileSync(audioPath, await audioDlRes.buffer());
            videoTemp.push(audioPath);

            const mergedPath = path.join(TEMP_DIR, `merged_${jobId}_${Date.now()}.mp4`);
            await execAsync(`ffmpeg -i "${finalVideoPath}" -stream_loop -1 -i "${audioPath}" -map 0:v -map 1:a -c:v copy -c:a aac -shortest -y "${mergedPath}"`, { timeout: 120000 });
            videoTemp.push(mergedPath);
            finalVideoPath = mergedPath;
            console.log('[ZIP] Audio merged ✓');
          }

          // Generate AI meta
          const rawTitle = videoName.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
          let meta = { title: rawTitle, description: '', hashtags: [], tags: [] };

          if (aiService && aiKey) {
            try {
              const prompt = `You are an expert Islamic YouTube Shorts content creator for a Bengali audience. The audio file name is: "${rawTitle}" (this is the WAZ/MOTIVATION audio title - base your content on this). STRICT RULES: 1) Return ONLY valid JSON, zero explanation, zero markdown backticks. 2) Title: Bengali, emotional/motivational, emoji-rich (☪️🤲📿🕌✨), max 60 chars, inspired by the audio filename meaning. 3) Description: 3 lines Bengali Islamic motivation ending with relevant duas/ayat reference. 4) Hashtags: Mix HIGH volume + NICHE tags. Use these proven viral Islamic hashtags: #shorts #islamicshorts #waz #islamicvideo #quran #allah #islam #muslim #bangla #bangladesh #viral #islamicmotivation #deen #alhamdulillah #subhanallah — then add 5 more relevant to the audio topic. Total exactly 20 hashtags. 5) Tags: Include both Bengali phonetic + English SEO tags. Must include: islamic shorts, bangla waz, islamic motivation, quran, allah, muslim, bangladesh, viral islamic, waz mahfil, islamic video bangla, deen, hadith, sunnah, islamic quotes — then add topic-specific tags. Total exactly 25 tags. Return exactly: {"title":"বাংলা ইসলামিক টাইটেল ☪️","description":"লাইন ১
লাইন ২
লাইন ৩","hashtags":["#shorts",...exactly 20],"tags":["islamic shorts",...exactly 25]}`;
              let aiText = '';
              if (aiService === 'gemini') {
                const ar = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${aiKey}`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
                });
                aiText = (await ar.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
              } else if (aiService === 'grok') {
                const ar = await fetch('https://api.x.ai/v1/chat/completions', {
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiKey}` },
                  body: JSON.stringify({ model: 'grok-3-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 800 })
                });
                aiText = (await ar.json()).choices?.[0]?.message?.content || '';
              } else if (aiService === 'openai') {
                const ar = await fetch('https://api.openai.com/v1/chat/completions', {
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiKey}` },
                  body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 800 })
                });
                aiText = (await ar.json()).choices?.[0]?.message?.content || '';
              }
              if (aiText) {
                const parsed = JSON.parse(aiText.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim());
                meta = { ...meta, ...parsed };
              }
            } catch(e) { console.warn('[ZIP] AI failed:', e.message); }
          }

          // Upload to YouTube
          const fullDesc = `${meta.description || ''}\n\n${(meta.hashtags || []).join(' ')}`.trim();
          const ytMeta = {
            snippet: { title: (meta.title || rawTitle).substring(0, 100), description: fullDesc.substring(0, 5000), tags: (meta.tags || []).slice(0, 30), categoryId: '22' },
            status: { privacyStatus: privacy || 'private', selfDeclaredMadeForKids: false }
          };

          const fileSize = fs.statSync(finalVideoPath).size;
          const initRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${ytToken}`, 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': fileSize },
            body: JSON.stringify(ytMeta)
          });
          if (!initRes.ok) throw new Error('YT init: ' + await initRes.text());

          const uploadUrl = initRes.headers.get('location');
          const videoBuf = fs.readFileSync(finalVideoPath);
          const upRes = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'video/mp4', 'Content-Length': videoBuf.length },
            body: videoBuf
          });
          if (!upRes.ok) throw new Error('YT upload: ' + await upRes.text());
          const ytData = await upRes.json();

          videoTemp.forEach(f => { try { if(fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
          results.push({ file: videoName, videoId: ytData.id, url: `https://youtu.be/${ytData.id}`, title: meta.title, status: 'ok' });
          console.log('[ZIP] Uploaded:', videoName, '→', ytData.id);

        } catch(e) {
          videoTemp.forEach(f => { try { if(fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
          results.push({ file: videoName, error: e.message, status: 'error' });
          console.error('[ZIP] Error:', videoName, e.message);
        }

        await new Promise(r => setTimeout(r, 3000));
      }

      // Cleanup extracted dir and zip
      tempFiles.forEach(f => {
        try { if(fs.existsSync(f)) { if(fs.statSync(f).isDirectory()) fs.rmSync(f, {recursive:true}); else fs.unlinkSync(f); } } catch {}
      });

      // Delete ZIP from Drive if requested
      if (deleteAfterUpload) {
        await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
          method: 'DELETE', headers: { 'Authorization': `Bearer ${driveToken}` }
        });
        console.log('[ZIP] Deleted ZIP from Drive');
      }

      jobs[jobId] = { status: 'done', result: { total: videoFiles.length, results } };
      console.log('[ZIP] All done!', results.filter(r=>r.status==='ok').length, '/', videoFiles.length);

    } catch(err) {
      tempFiles.forEach(f => { try { if(fs.existsSync(f)) { if(fs.statSync(f).isDirectory()) fs.rmSync(f,{recursive:true}); else fs.unlinkSync(f); } } catch {} });
      console.error('[ZIP] Fatal:', err.message);
      jobs[jobId] = { status: 'error', error: err.message };
    }
  })();
});
