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
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey || process.env.GEMINI_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9, maxOutputTokens: 1500 } })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message);
      text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else if (service === 'grok') {
      const r = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey || process.env.GROK_API_KEY}` },
        body: JSON.stringify({ model: 'grok-3-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.9, max_tokens: 1500 })
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

// ========== START ==========
app.listen(PORT, () => {
  console.log(`🚀 YouTube Automation Server running on port ${PORT}`);
  try { require('child_process').execSync('yt-dlp --version'); console.log('✓ yt-dlp available'); } catch { console.warn('✗ yt-dlp not found'); }
  try { require('child_process').execSync('ffmpeg -version 2>&1 | head -1'); console.log('✓ ffmpeg available'); } catch { console.warn('✗ ffmpeg not found'); }
});

// ========== DRIVE AUTO UPLOAD SYSTEM ==========

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
        return mimeFilter ? files.filter(f => f.mimeType?.includes(mimeFilter) || f.name?.match(mimeFilter)) : files;
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
        const prompt = `YouTube Shorts এর জন্য বাংলা viral metadata তৈরি করো: "${title}". শুধু JSON দাও কোনো ব্যাখ্যা ছাড়া: {"title":"ক্লিকবেইট টাইটেল ইমোজি সহ ৬০ অক্ষর","description":"৩ লাইন বাংলা বিবরণ","hashtags":["#ট্যাগ১","#ট্যাগ২",...মোট ১৫টি],"tags":["seo","tag",...মোট ২০টি ইংরেজি]}`;
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

// ========== KUAISHOU DOWNLOADER ==========
app.post('/api/kuaishou/download', async (req, res) => {
  const { url, mute = true } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const jobId = createJob();
  res.json({ jobId, status: 'processing' });

  (async () => {
    try {
      const fetch = (await import('node-fetch')).default;

      // Extract photo ID from various Kuaishou URL formats
      let photoId = null;

      function extractKsId(u) {
        // https://www.kuaishou.com/short-video/VIDEOID
        let m = u.match(/short-video\/([a-zA-Z0-9_-]+)/);
        if (m) return m[1];
        // https://www.kuaishou.com/f/VIDEOID
        m = u.match(/kuaishou\.com\/f\/([a-zA-Z0-9_-]+)/);
        if (m) return m[1];
        // photoId param
        m = u.match(/photoId=([a-zA-Z0-9_-]+)/);
        if (m) return m[1];
        // /photo/VIDEOID
        m = u.match(/\/photo\/([a-zA-Z0-9_-]+)/);
        if (m) return m[1];
        return null;
      }

      photoId = extractKsId(url);

      // If short URL (v.kuaishou.com), resolve redirect
      if (!photoId) {
        try {
          const redir = await fetch(url, {
            redirect: 'follow',
            headers: {
              'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
          });
          const finalUrl = redir.url;
          console.log('[KS] Resolved URL:', finalUrl);
          photoId = extractKsId(finalUrl);

          // Try reading HTML for photoId if still not found
          if (!photoId) {
            const html = await redir.text();
            const hm = html.match(/"photoId"\s*:\s*"([a-zA-Z0-9_-]+)"/);
            if (hm) photoId = hm[1];
            const hm2 = html.match(/photoId=([a-zA-Z0-9_-]+)/);
            if (!photoId && hm2) photoId = hm2[1];
          }
        } catch (e) { console.warn('[KS] Redirect failed:', e.message); }
      }

      if (!photoId) throw new Error('Video ID বের করা গেলো না। URL টা ঠিক আছে?');

      // Try multiple GraphQL endpoints
      const gqlEndpoints = [
        'https://www.kuaishou.com/graphql',
        'https://v.m.chenzhongtech.com/graphql',
        'https://www.kwai.com/graphql'
      ];

      let photo = null;
      for (const endpoint of gqlEndpoints) {
        try {
          const gqlRes = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
              'Referer': endpoint.replace('/graphql', '/'),
              'Origin': endpoint.replace('/graphql', '')
            },
            body: JSON.stringify({
              operationName: 'visionVideoDetail',
              variables: { photoId, page: 'selected' },
              query: `query visionVideoDetail($photoId: String, $type: String, $page: String) {
                visionVideoDetail(photoId: $photoId, type: $type, page: $page) {
                  photo { id caption coverUrl photoUrl }
                }
              }`
            })
          });
          const gqlData = await gqlRes.json();
          console.log('[KS] GraphQL response from', endpoint, ':', JSON.stringify(gqlData).substring(0, 200));
          photo = gqlData?.data?.visionVideoDetail?.photo;
          if (photo?.photoUrl) break;
        } catch (e) { console.warn('[KS] Endpoint failed:', endpoint, e.message); }
      }
      if (!photo?.photoUrl) throw new Error('Video URL পাওয়া গেলো না। Video private হতে পারে।');

      const videoUrl = photo.photoUrl;
      const title = photo.caption || 'Kuaishou_' + photoId;
      const thumbnail = photo.coverUrl || null;

      // Download video
      const outPath = path.join(TEMP_DIR, `ks_${jobId}.mp4`);
      const vidRes = await fetch(videoUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.kuaishou.com/' }
      });
      if (!vidRes.ok) throw new Error('Video download failed: ' + vidRes.status);
      const buffer = await vidRes.buffer();
      fs.writeFileSync(outPath, buffer);

      // Mute if needed
      let finalPath = outPath;
      if (mute) {
        const mutedPath = path.join(TEMP_DIR, `ks_muted_${jobId}.mp4`);
        await execAsync(`ffmpeg -i "${outPath}" -an -c:v copy -y "${mutedPath}"`, { timeout: 60000 });
        fs.unlinkSync(outPath);
        finalPath = mutedPath;
      }

      const stat = fs.statSync(finalPath);
      const filename = path.basename(finalPath);

      jobs[jobId] = {
        status: 'done',
        result: {
          title: title.substring(0, 100),
          filename,
          filepath: finalPath,
          thumbnail,
          size: (stat.size / 1024 / 1024).toFixed(1) + 'MB',
          source: 'kuaishou'
        }
      };

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
