// YouTube Automation Backend - Railway Deployment
// Node.js + Express + yt-dlp + FFmpeg

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execSync, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

// ====== MIDDLEWARE ======
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/temp', express.static(path.join(__dirname, 'temp')));

// Ensure temp dir exists
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ====== HEALTH ======
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));


// ====== OAUTH TOKEN STORAGE ======
const TOKEN_FILE = path.join(__dirname, 'tokens.json');

function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  if (tokens.access_token) process.env.YT_ACCESS_TOKEN = tokens.access_token;
  if (tokens.drive_access_token) process.env.DRIVE_ACCESS_TOKEN = tokens.drive_access_token;
}

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (t.access_token) process.env.YT_ACCESS_TOKEN = t.access_token;
      if (t.drive_access_token) process.env.DRIVE_ACCESS_TOKEN = t.drive_access_token;
      return t;
    }
  } catch {}
  return {};
}

// Load tokens on startup
loadTokens();

// Check connection status
app.get('/api/status', (req, res) => {
  const tokens = loadTokens();
  res.json({
    youtube: !!tokens.access_token,
    drive: !!tokens.drive_access_token,
    ytChannel: tokens.channel_name || null
  });
});

// Disconnect
app.post('/api/disconnect', (req, res) => {
  const { service } = req.body;
  const tokens = loadTokens();
  if (service === 'youtube') delete tokens.access_token;
  if (service === 'drive') delete tokens.drive_access_token;
  saveTokens(tokens);
  res.json({ success: true });
});


// ====== VIDEO STREAM (for preview) ======
app.get('/api/stream', (req, res) => {
  const { file } = req.query;
  if (!file) return res.status(400).send('No file');
  
  const filePath = path.join(TEMP_DIR, path.basename(file));
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
  
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ====== LIST TEMP FILES ======
app.get('/api/files', (req, res) => {
  try {
    const files = fs.readdirSync(TEMP_DIR)
      .filter(f => f.endsWith('.mp4'))
      .map(f => {
        const fp = path.join(TEMP_DIR, f);
        const stat = fs.statSync(fp);
        return { name: f, size: stat.size, path: fp };
      });
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====== DOWNLOAD VIDEO ======
app.post('/api/download', async (req, res) => {
  const { url, quality = 'best', mute = true, removeTikTokWatermark = true } = req.body;
  
  if (!url) return res.status(400).json({ error: 'URL required' });
  
  try {
    const id = Date.now() + '_' + Math.random().toString(36).substr(2, 8);
    const outputTemplate = path.join(TEMP_DIR, `${id}.%(ext)s`);
    
    // Build yt-dlp command with multiple format fallbacks
    let formatArgs = '';
    if (quality === 'best') formatArgs = '-f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"';
    else if (quality === '1080p') formatArgs = '-f "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]/best"';
    else if (quality === '720p') formatArgs = '-f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]/best"';
    else if (quality === '480p') formatArgs = '-f "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]/best"';
    else formatArgs = '-f "best[ext=mp4]/best"';
    
    const isTikTok = url.includes('tiktok.com') || url.includes('vt.tiktok.com');

    // TikTok watermark-free + impersonation
    const finalFormat = isTikTok
      ? '-f "download_addr-2/download_addr/play_addr/best[ext=mp4]/best"'
      : formatArgs;

    const extraArgs = isTikTok
      ? '--impersonate "chrome-110" --add-header "Referer:https://www.tiktok.com/"'
      : '';

    const cmd = `yt-dlp ${finalFormat} ${extraArgs} \
      --merge-output-format mp4 \
      --write-thumbnail \
      --convert-thumbnails jpg \
      --no-playlist \
      --retries 5 \
      --fragment-retries 5 \
      --retry-sleep 3 \
      -o "${outputTemplate}" \
      "${url}"`;
    
    console.log('Downloading:', url);
    const { stdout, stderr } = await execAsync(cmd, { timeout: 300000 });
    
    // Find downloaded file
    const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(id) && f.endsWith('.mp4'));
    if (!files.length) throw new Error('Download failed - no output file');
    
    const videoFile = files[0];
    const videoPath = path.join(TEMP_DIR, videoFile);
    
    // Get title from yt-dlp info
    let title = videoFile.replace('.mp4', '').substring(id.length + 1) || 'Video';
    
    // Try to get info
    try {
      const infoCmd = `yt-dlp --skip-download --print title "${url}" 2>/dev/null`;
      const { stdout: titleOut } = await execAsync(infoCmd, { timeout: 30000 });
      title = titleOut.trim() || title;
    } catch {}
    
    // Get duration and size
    let duration = '?';
    try {
      const { stdout: dur } = await execAsync(`ffprobe -v quiet -print_format json -show_format "${videoPath}"`);
      const info = JSON.parse(dur);
      const secs = parseFloat(info.format?.duration || 0);
      duration = `${Math.floor(secs/60)}:${String(Math.floor(secs%60)).padStart(2,'0')}`;
    } catch {}
    
    const stats = fs.statSync(videoPath);
    const size = (stats.size / 1024 / 1024).toFixed(1) + 'MB';
    
    // Find thumbnail
    const thumbFiles = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(id) && (f.endsWith('.jpg') || f.endsWith('.webp')));
    const thumbnail = thumbFiles.length ? `/temp/${thumbFiles[0]}` : null;
    
    // Mute video if requested
    let finalPath = videoPath;
    if (mute) {
      const mutedPath = path.join(TEMP_DIR, `${id}_muted.mp4`);
      try {
        await execAsync(`ffmpeg -i "${videoPath}" -an -c:v copy "${mutedPath}" -y`);
        fs.unlinkSync(videoPath);
        finalPath = mutedPath;
      } catch { finalPath = videoPath; }
    }
    
    res.json({
      success: true,
      filename: path.basename(finalPath),
      filepath: finalPath,
      title,
      duration,
      size,
      thumbnail,
      muted: mute
    });
    
  } catch (err) {
    console.error('Download error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ====== EXTRACT AUDIO ======
app.post('/api/extract-audio', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  
  try {
    const id = 'audio_' + Date.now();
    const outputPath = path.join(TEMP_DIR, `${id}.mp3`);
    
    const cmd = `yt-dlp \
      -f "bestaudio/best" \
      --extract-audio \
      --audio-format mp3 \
      --audio-quality 192K \
      --no-playlist \
      --retries 5 \
      -o "${path.join(TEMP_DIR, id + '.%(ext)s')}" \
      "${url}"`;
    
    await execAsync(cmd, { timeout: 120000 });
    
    const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(id));
    const audioFile = files.find(f => f.endsWith('.mp3') || f.endsWith('.m4a')) || files[0];
    if (!audioFile) throw new Error('Audio extraction failed');
    
    // Get title
    let title = 'Audio';
    try {
      const { stdout } = await execAsync(`yt-dlp --skip-download --print title "${url}" 2>/dev/null`, { timeout: 20000 });
      title = stdout.trim() || title;
    } catch {}
    
    // Get duration
    let duration = '?';
    try {
      const filePath = path.join(TEMP_DIR, audioFile);
      const { stdout } = await execAsync(`ffprobe -v quiet -print_format json -show_format "${filePath}"`);
      const info = JSON.parse(stdout);
      const secs = parseFloat(info.format?.duration || 0);
      duration = `${Math.floor(secs/60)}:${String(Math.floor(secs%60)).padStart(2,'0')}`;
    } catch {}
    
    const stats = fs.statSync(path.join(TEMP_DIR, audioFile));
    
    res.json({
      success: true,
      title,
      audioUrl: `/temp/${audioFile}`,
      filepath: path.join(TEMP_DIR, audioFile),
      duration,
      size: (stats.size / 1024 / 1024).toFixed(1) + 'MB'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====== MERGE AUDIO + VIDEO ======
app.post('/api/merge-audio', async (req, res) => {
  const { videoPath, audioPath, outputPath } = req.body;
  
  try {
    if (!videoPath || !fs.existsSync(videoPath)) {
      throw new Error('Video file not found: ' + videoPath);
    }
    
    // Audio can be a URL or local path
    let localAudioPath = audioPath;
    if (audioPath && audioPath.startsWith('/temp/')) {
      localAudioPath = path.join(TEMP_DIR, path.basename(audioPath));
    }
    
    if (!localAudioPath || !fs.existsSync(localAudioPath)) {
      throw new Error('Audio file not found: ' + audioPath);
    }
    
    const outFile = path.join(TEMP_DIR, path.basename(videoPath).replace('.mp4', '_merged.mp4'));
    
    // Merge: loop audio to match video length
    const cmd = `ffmpeg -i "${videoPath}" -stream_loop -1 -i "${localAudioPath}" -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -shortest "${outFile}" -y`;
    
    await execAsync(cmd, { timeout: 180000 });
    
    if (!fs.existsSync(outFile)) throw new Error('Merge output not created');
    
    // Delete original
    if (fs.existsSync(videoPath) && videoPath !== outFile) {
      fs.unlinkSync(videoPath);
    }
    
    res.json({ success: true, outputPath: outFile, filename: path.basename(outFile) });
  } catch (err) {
    console.error('Merge error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ====== AI GENERATE META ======
app.post('/api/ai-generate', async (req, res) => {
  const { service, apiKey, prompt, lang } = req.body;
  
  try {
    let result;
    
    if (service === 'gemini') {
      result = await callGemini(apiKey || process.env.GEMINI_API_KEY, prompt);
    } else if (service === 'grok') {
      result = await callGrok(apiKey || process.env.GROK_API_KEY, prompt);
    } else if (service === 'openai') {
      result = await callOpenAI(apiKey || process.env.OPENAI_API_KEY, prompt);
    } else {
      throw new Error('Unknown AI service: ' + service);
    }
    
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function callGemini(apiKey, prompt) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.9, maxOutputTokens: 1500 }
    })
  });
  
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Gemini error');
  
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return parseAIResponse(text);
}

async function callGrok(apiKey, prompt) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'grok-beta',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.9,
      max_tokens: 1500
    })
  });
  
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Grok error');
  
  const text = data.choices?.[0]?.message?.content || '';
  return parseAIResponse(text);
}

async function callOpenAI(apiKey, prompt) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4-turbo-preview',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.9,
      max_tokens: 1500,
      response_format: { type: 'json_object' }
    })
  });
  
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'OpenAI error');
  
  const text = data.choices?.[0]?.message?.content || '';
  return parseAIResponse(text);
}

function parseAIResponse(text) {
  // Clean up potential markdown code blocks
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  
  try {
    const parsed = JSON.parse(cleaned);
    return {
      title: parsed.title || '',
      description: parsed.description || '',
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      category: parsed.category || ''
    };
  } catch {
    // Fallback: extract from text
    const titleMatch = text.match(/"title":\s*"([^"]+)"/);
    const descMatch = text.match(/"description":\s*"([^"]+)"/);
    return {
      title: titleMatch?.[1] || text.substring(0, 100),
      description: descMatch?.[1] || '',
      hashtags: (text.match(/#[^\s#,]+/g) || []).slice(0, 20),
      tags: [],
      category: ''
    };
  }
}

// ====== UPLOAD TO YOUTUBE ======
app.post('/api/upload', async (req, res) => {
  const { filepath, title, description, tags, hashtags, privacy, categoryId, deleteAfter } = req.body;
  
  try {
    const tokens = loadTokens();
    const accessToken = req.headers['authorization']?.replace('Bearer ', '') || tokens.access_token || process.env.YT_ACCESS_TOKEN;
    if (!accessToken) throw new Error('YouTube access token required. Please connect YouTube first.');
    
    const fetch = (await import('node-fetch')).default;
    const FormData = (await import('form-data')).default;
    
    // Full description with hashtags
    const fullDesc = `${description}\n\n${(hashtags || []).join(' ')}\n\n${(tags || []).slice(0,3).join(' ')}`;
    
    const metadata = {
      snippet: {
        title: title.substring(0, 100),
        description: fullDesc.substring(0, 5000),
        tags: (tags || []).slice(0, 30),
        categoryId: categoryId || '22',
        defaultLanguage: 'bn'
      },
      status: {
        privacyStatus: privacy || 'private',
        selfDeclaredMadeForKids: false
      }
    };
    
    // Resumable upload
    const initRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': fs.statSync(filepath).size
      },
      body: JSON.stringify(metadata)
    });
    
    if (!initRes.ok) {
      const errText = await initRes.text();
      throw new Error('Upload init failed: ' + errText);
    }
    
    const uploadUrl = initRes.headers.get('location');
    const videoBuffer = fs.readFileSync(filepath);
    
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': videoBuffer.length
      },
      body: videoBuffer
    });
    
    if (!uploadRes.ok) throw new Error('Video upload failed: ' + await uploadRes.text());
    
    const videoData = await uploadRes.json();
    const videoId = videoData.id;
    
    // Delete after upload if requested
    if (deleteAfter && filepath && fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
    
    res.json({ success: true, videoId, url: `https://youtu.be/${videoId}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====== EXPORT ZIP ======
app.post('/api/export-zip', async (req, res) => {
  const { filepaths, uploadToDrive, driveFolderId } = req.body;
  
  try {
    const archiver = require('archiver');
    const zipName = `videos_${Date.now()}.zip`;
    const zipPath = path.join(TEMP_DIR, zipName);
    
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      
      filepaths.forEach(fp => {
        if (fp && fs.existsSync(fp)) {
          archive.file(fp, { name: path.basename(fp) });
        }
      });
      
      archive.finalize();
    });
    
    // Upload to Google Drive if requested
    if (uploadToDrive) {
      try {
        const driveUrl = await uploadToDriveAPI(zipPath, zipName, driveFolderId);
        res.json({ success: true, driveUrl, zipName });
        return;
      } catch (driveErr) {
        console.error('Drive upload failed:', driveErr.message);
      }
    }
    
    // Return download URL
    res.json({ success: true, downloadUrl: `/temp/${zipName}`, zipName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function uploadToDriveAPI(filePath, fileName, folderId) {
  const fetch = (await import('node-fetch')).default;
  const FormData = (await import('form-data')).default;
  const accessToken = process.env.DRIVE_ACCESS_TOKEN;
  
  if (!accessToken) throw new Error('Drive access token not set');
  
  const metadata = { name: fileName, parents: folderId ? [folderId] : [] };
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata), { contentType: 'application/json' });
  form.append('file', fs.createReadStream(filePath), { contentType: 'application/zip' });
  
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, ...form.getHeaders() },
    body: form
  });
  
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return `https://drive.google.com/file/d/${data.id}/view`;
}

// ====== DELETE FILE ======
app.post('/api/delete', (req, res) => {
  const { filepath } = req.body;
  try {
    if (filepath && fs.existsSync(filepath)) fs.unlinkSync(filepath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====== OAUTH CALLBACKS ======
app.get('/auth/youtube/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code');
  
  try {
    const fetch = (await import('node-fetch')).default;
    const clientId = process.env.YT_CLIENT_ID;
    const clientSecret = process.env.YT_CLIENT_SECRET;
    const redirectUri = `${process.env.BASE_URL}/auth/youtube/callback`;
    
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri, grant_type: 'authorization_code'
      })
    });
    
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error(JSON.stringify(tokens));
    
    // Get channel name
    let channelName = '';
    try {
      const chRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
        headers: { 'Authorization': `Bearer ${tokens.access_token}` }
      });
      const chData = await chRes.json();
      channelName = chData.items?.[0]?.snippet?.title || '';
    } catch {}
    
    // Save tokens persistently
    const existing = loadTokens();
    saveTokens({ ...existing, access_token: tokens.access_token, refresh_token: tokens.refresh_token, channel_name: channelName });
    
    res.send(`<html><body style="background:#0a0a0f;color:#06d6a0;font-family:sans-serif;text-align:center;padding:40px">
      <h2>✅ YouTube সংযুক্ত হয়েছে!</h2>
      <p>${channelName ? 'চ্যানেল: ' + channelName : ''}</p>
      <p style="color:#9090b0">এই পেজ বন্ধ করুন এবং অ্যাপে ফিরে যান।</p>
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>`);
  } catch (err) {
    res.status(500).send('<h2 style="color:red">Auth error: ' + err.message + '</h2>');
  }
});

// Google Drive OAuth
app.get('/auth/drive/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code');
  
  try {
    const fetch = (await import('node-fetch')).default;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.DRIVE_CLIENT_ID || process.env.YT_CLIENT_ID,
        client_secret: process.env.DRIVE_CLIENT_SECRET || process.env.YT_CLIENT_SECRET,
        redirect_uri: `${process.env.BASE_URL}/auth/drive/callback`,
        grant_type: 'authorization_code'
      })
    });
    
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error(JSON.stringify(tokens));
    
    const existing = loadTokens();
    saveTokens({ ...existing, drive_access_token: tokens.access_token, drive_refresh_token: tokens.refresh_token });
    
    res.send(`<html><body style="background:#0a0a0f;color:#06d6a0;font-family:sans-serif;text-align:center;padding:40px">
      <h2>✅ Google Drive সংযুক্ত হয়েছে!</h2>
      <p style="color:#9090b0">এই পেজ বন্ধ করুন এবং অ্যাপে ফিরে যান।</p>
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>`);
  } catch (err) {
    res.status(500).send('<h2 style="color:red">Auth error: ' + err.message + '</h2>');
  }
});

// ====== SERVE FRONTEND ======
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ====== START ======
app.listen(PORT, () => {
  console.log(`🚀 YouTube Automation Server running on port ${PORT}`);
  
  // Check yt-dlp
  try { execSync('yt-dlp --version'); console.log('✓ yt-dlp available'); }
  catch { console.warn('⚠ yt-dlp not found. Install: pip install yt-dlp'); }
  
  // Check ffmpeg
  try { execSync('ffmpeg -version'); console.log('✓ ffmpeg available'); }
  catch { console.warn('⚠ ffmpeg not found'); }
});
