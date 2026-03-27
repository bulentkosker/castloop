require('dotenv').config({ path: '/root/.env' });
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { spawn } = require('child_process');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const API_KEY = 'castloop-secret-2024';
app.use(cors());
app.use('/paddle-webhook', express.raw({ type: '*/*' }));
app.use('/lemonsqueezy-webhook', express.raw({ type: '*/*' }));
app.use(express.json());

const SUPABASE_URL = 'https://pdttjblnvxoitskhdtro.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const supabaseAdmin = supabase;

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (req.path === '/paddle-webhook') return next();
  if (req.path === '/lemonsqueezy-webhook') return next();
  if (req.path === '/upload-token/validate') return next();
  if (req.path === '/upload-by-token') return next();
  const streamQueryKey = req.path.startsWith('/stream/') ? req.query.apiKey : null;
  const key = req.headers['x-api-key'] || streamQueryKey;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userId = req.headers['x-user-id'];
    if (!userId) return cb(new Error('No user ID'));
    const dir = `/var/castloop/videos/${userId}`;
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 * 1024 } });


const PRICE_PLAN_MAP = {
  'pri_01kkq2qhxdmqreg93wfa90cqqr': 'lite',
  'pri_01kkq68n48m06g366npzg7fk01': 'lite',
  'pri_01kkq6k6kr5xmza70p6n574378': 'basic',
  'pri_01kkq6n0p98rx63q3dj6qd4c83': 'basic',
  'pri_01kkq6tjh7rmq5s19ns35n52d7': 'pro',
  'pri_01kkq6vvphytz0xjk2y2vqswv2': 'pro',
  'pri_01kkq6y9a729e82r153t4ckakr': 'business',
  'pri_01kkq70cs983hs30fqxq5s2sga': 'business',
  'pri_01kkq72xsn1hvest90mdw6ag4e': 'enterprise',
  'pri_01kkq748ydd7tcdbky4zfsdkda': 'enterprise',
  'pri_01kmcxn7vvjz06vhpbjg6zyxyq': '4k_starter',
  'pri_01kmcxqe1n6sk6st551z4gjpbw': '4k_starter',
  'pri_01kmcxszdwcdk30bpwga1qnyq7': '4k_plus',
  'pri_01kmcxvg3t6krm3twh9tp35pjj': '4k_plus',
  'pri_01kmcxx4491c5m32tr70ah258x': '4k_pro',
  'pri_01kmcxy7vwxqez6jzyqjdfy438': '4k_pro',
};

// Plan bazlı depolama limitleri (bytes)
const STORAGE_LIMITS = {
  free:       5  * 1024 * 1024 * 1024,  // 5 GB
  trial:      5  * 1024 * 1024 * 1024,  // 5 GB
  lite:       20 * 1024 * 1024 * 1024,  // 20 GB
  basic:      50 * 1024 * 1024 * 1024,  // 50 GB
  pro:        100 * 1024 * 1024 * 1024, // 100 GB
  business:   200 * 1024 * 1024 * 1024, // 200 GB
  enterprise: 500 * 1024 * 1024 * 1024, // 500 GB
};

function getUserDiskUsage(userId) {
  const dir = `/var/castloop/videos/${userId}/`;
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir)
    .filter(f => f !== '_meta.json')
    .reduce((total, f) => {
      try { return total + fs.statSync(dir + f).size; } catch { return total; }
    }, 0);
}


function getVideoResolution(filePath) {
  return new Promise((resolve) => {
    const ff = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'json',
      filePath
    ]);
    let out = '';
    ff.stdout.on('data', d => out += d);
    ff.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        const stream = parsed.streams && parsed.streams[0];
        resolve({ width: stream ? stream.width : null, height: stream ? stream.height : null });
      } catch (e) {
        resolve({ width: null, height: null });
      }
    });
  });
}

function getVideoMetadata(filePath) {
  return new Promise((resolve) => {
    const ff = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'format=duration',
      '-show_entries', 'stream=r_frame_rate',
      '-of', 'json',
      filePath
    ]);
    let out = '';
    ff.stdout.on('data', d => out += d);
    ff.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        const format = parsed.format || {};
        const stream = parsed.streams && parsed.streams[0];
        let fps = null;
        if (stream && stream.r_frame_rate) {
          const parts = stream.r_frame_rate.split('/');
          const num = parseInt(parts[0], 10);
          const den = parts.length > 1 ? parseInt(parts[1], 10) : 1;
          fps = den ? Math.round(num / den) : num;
        }
        const duration = format.duration ? Math.round(parseFloat(format.duration)) : null;
        resolve({ duration, fps });
      } catch (e) {
        resolve({ duration: null, fps: null });
      }
    });
  });
}

const activeStreams = {};
const streamConfigs = {};
const streamStopped = {};
const streamStartTime = {};
const streamFailCount = {};
const streamMaxDurationTimers = {};
const streamRestartByDuration = {};


function clearMaxDurationTimer(streamId) {
  if (streamMaxDurationTimers[streamId]) {
    clearTimeout(streamMaxDurationTimers[streamId]);
    delete streamMaxDurationTimers[streamId];
  }
}

function scheduleMaxDurationRestart(streamId) {
  clearMaxDurationTimer(streamId);
  const cfg = streamConfigs[streamId];
  if (!cfg) return;

  const parsed = Number(cfg.maxDuration);
  const maxDuration = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 43200;

  streamMaxDurationTimers[streamId] = setTimeout(() => {
    if (streamStopped[streamId] || !streamConfigs[streamId] || !activeStreams[streamId]) return;

    console.log('[' + streamId + '] Max duration ' + maxDuration + 's reached. Recycling stream in 3s.');
    streamRestartByDuration[streamId] = true;
    activeStreams[streamId].kill('SIGTERM');

    setTimeout(() => {
      if (!streamStopped[streamId] && streamConfigs[streamId] && !activeStreams[streamId]) {
        startFFmpeg(streamId);
      }
    }, 3000);
  }, maxDuration * 1000);
}


function parseVideoPaths(raw) {
  const extractPath = (item) => (typeof item === 'object' && item !== null ? item.path : item);
  if (Array.isArray(raw)) return raw.map(extractPath).filter(Boolean);
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(extractPath).filter(Boolean) : [raw];
    } catch {
      return [raw];
    }
  }
  return [];
}

async function recoverRunningStreamsOnStartup() {
  try {
    console.log('[startup-recovery] Fetching running streams from Supabase...');
    const { data, error } = await supabaseAdmin
      .from('streams')
      .select('id, rtmp_url, stream_key, video_paths, server_id, status')
      .eq('status', 'running');

    if (error) {
      console.error('[startup-recovery] Supabase query error:', error.message || error);
      return;
    }

    if (!data || !data.length) {
      console.log('[startup-recovery] No running streams to recover.');
      return;
    }

    let recovered = 0;
    let skipped = 0;

    for (const stream of data) {
      const streamId = String(stream.id || '');
      const rtmpUrl = stream.rtmp_url || stream.rtmpUrl;
      const streamKey = stream.stream_key || stream.streamKey;
      const videoPaths = parseVideoPaths(stream.video_paths || stream.videoPaths);
      const serverId = stream.server_id || stream.serverId || null;

      const safeMaxDuration = 43200; // 12h default, no max_duration column

      if (!streamId || !rtmpUrl || !streamKey || !videoPaths.length) {
        skipped += 1;
        console.log('[startup-recovery] Skipping invalid stream row:', {
          streamId,
          serverId,
          hasRtmpUrl: !!rtmpUrl,
          hasStreamKey: !!streamKey,
          videoPathsCount: videoPaths.length
        });
        continue;
      }

      if (activeStreams[streamId]) {
        skipped += 1;
        continue;
      }

      streamConfigs[streamId] = { rtmpUrl, streamKey, videoPaths, maxDuration: safeMaxDuration, serverId };
      streamStopped[streamId] = false;
      streamFailCount[streamId] = 0;
      startFFmpeg(streamId);
      try {
        await supabaseAdmin.from('streams').update({ status: 'running' }).eq('id', streamId);
      } catch (updateErr) {
        console.error('[startup-recovery] Failed to update stream status:', updateErr.message || updateErr);
      }
      recovered += 1;

      console.log('[startup-recovery] Recovered stream:', streamId, 'server_id=', serverId);
    }

    console.log('[startup-recovery] Completed. recovered=' + recovered + ', skipped=' + skipped);
    recoverRunningStreamsOnStartup._done = true;
  } catch (err) {
    console.error('[startup-recovery] Unexpected error:', err.message || err);
    recoverRunningStreamsOnStartup._done = true;
  }
}

function buildConcatFile(videoPaths, streamId) {
  const concatPath = `/tmp/playlist_${streamId}.txt`;
  const content = videoPaths.map(p => `file '${p}'`).join('\n');
  fs.writeFileSync(concatPath, content);
  return concatPath;
}

function startFFmpeg(streamId) {
  const { rtmpUrl, streamKey, videoPaths } = streamConfigs[streamId];
  const destination = `${rtmpUrl}/${streamKey}`;

  const is4K = process.env.SERVER_TYPE === '4k';

  let ffmpegArgs;
  if (videoPaths.length === 1) {
    ffmpegArgs = is4K
      ? [
          '-re', '-stream_loop', '-1', '-i', videoPaths[0],
          '-c:v', 'copy', '-c:a', 'copy',
          '-f', 'flv', destination
        ]
      : [
          '-re', '-stream_loop', '-1', '-i', videoPaths[0],
          '-c:v', 'libx264', '-preset', 'ultrafast',
          '-b:v', '3000k', '-maxrate', '3000k', '-bufsize', '6000k',
          '-vf', 'scale=1920:1080',
          '-pix_fmt', 'yuv420p', '-g', '60',
          '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
          '-f', 'flv', destination
        ];
  } else {
    const concatFile = buildConcatFile(videoPaths, streamId);
    ffmpegArgs = is4K
      ? [
          '-re', '-stream_loop', '-1',
          '-f', 'concat', '-safe', '0', '-i', concatFile,
          '-c:v', 'copy', '-c:a', 'copy',
          '-f', 'flv', destination
        ]
      : [
          '-re', '-stream_loop', '-1',
          '-f', 'concat', '-safe', '0', '-i', concatFile,
          '-c:v', 'libx264', '-preset', 'ultrafast',
          '-b:v', '3000k', '-maxrate', '3000k', '-bufsize', '6000k',
          '-vf', 'scale=1920:1080',
          '-pix_fmt', 'yuv420p', '-g', '60',
          '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
          '-f', 'flv', destination
        ];
  }

  streamStartTime[streamId] = Date.now();
  const ffmpeg = spawn('ffmpeg', ffmpegArgs);
  activeStreams[streamId] = ffmpeg;
  scheduleMaxDurationRestart(streamId);

  ffmpeg.stderr.on('data', (data) => console.log(`[${streamId}] ${data}`));

  ffmpeg.on('close', (code) => {
    console.log(`[${streamId}] Stream ended with code ${code}`);
    delete activeStreams[streamId];

    if (streamRestartByDuration[streamId]) {
      // Normal duration recycle: close handler does nothing (restart already scheduled)
      delete streamRestartByDuration[streamId];
      return;
    }

    if (streamStopped[streamId]) {
      // Kullanıcı durdurdu, temizle
      delete streamConfigs[streamId];
      delete streamStopped[streamId];
      delete streamStartTime[streamId];
      delete streamFailCount[streamId];
      return;
    }

    // Kaç saniyede kapandı?
    const elapsed = Date.now() - (streamStartTime[streamId] || 0);
    if (elapsed < 15000) {
      // 15 saniyeden kısa sürede kapandı — hata say
      streamFailCount[streamId] = (streamFailCount[streamId] || 0) + 1;
      console.log(`[${streamId}] Fast failure #${streamFailCount[streamId]}`);
    } else {
      // Uzun süre çalıştı, sayacı sıfırla
      streamFailCount[streamId] = 0;
    }

    // 3 kez üst üste hızlı kapandıysa watchdog'u durdur
    if (streamFailCount[streamId] >= 3) {
      console.log(`[${streamId}] Too many failures, giving up.`);
      delete streamConfigs[streamId];
      delete streamStartTime[streamId];
      delete streamFailCount[streamId];
      return;
    }

    // Yeniden başlat
    console.log(`[${streamId}] Restarting in 5s...`);
    setTimeout(() => {
      if (!streamStopped[streamId] && streamConfigs[streamId]) {
        startFFmpeg(streamId);
      }
    }, 5000);
  });
}

app.post('/start', (req, res) => {
  const { streamId, rtmpUrl, streamKey, videoPaths, videoPath, maxDuration } = req.body;
  if (!streamId || !rtmpUrl || !streamKey)
    return res.status(400).json({ error: 'Missing parameters' });

  const paths = (typeof videoPaths === 'string' ? JSON.parse(videoPaths) : videoPaths)
    || (videoPath ? [videoPath] : null);
  if (!paths || !paths.length)
    return res.status(400).json({ error: 'No video path provided' });

  if (activeStreams[streamId])
    return res.status(400).json({ error: 'Stream already running' });

  const parsedMaxDuration = Number(maxDuration);
  const safeMaxDuration = Number.isFinite(parsedMaxDuration) && parsedMaxDuration > 0
    ? Math.floor(parsedMaxDuration)
    : 43200;

  streamConfigs[streamId] = { rtmpUrl, streamKey, videoPaths: paths, maxDuration: safeMaxDuration };
  streamStopped[streamId] = false;
  streamFailCount[streamId] = 0;
  startFFmpeg(streamId);
  res.json({ success: true, message: 'Stream started', maxDuration: safeMaxDuration });
});

app.post('/stop', (req, res) => {
  const { streamId } = req.body;

  // activeStreams'de yoksa ama config varsa temizle
  if (!activeStreams[streamId]) {
    if (streamConfigs[streamId]) {
      streamStopped[streamId] = true;
      delete streamConfigs[streamId];
      delete streamStartTime[streamId];
      delete streamFailCount[streamId];
      return res.json({ success: true, message: 'Stream stopped' });
    }
    return res.status(400).json({ error: 'Stream not found' });
  }

  streamStopped[streamId] = true;
  clearMaxDurationTimer(streamId);
  delete streamRestartByDuration[streamId];
  activeStreams[streamId].kill('SIGTERM');
  delete activeStreams[streamId];
  res.json({ success: true, message: 'Stream stopped' });
});

app.post('/delete', (req, res) => {
  const { streamId } = req.body;
  if (!streamId) return res.status(400).json({ error: 'streamId required' });

  // Kill FFmpeg process if running
  if (activeStreams[streamId]) {
    activeStreams[streamId].kill('SIGTERM');
    delete activeStreams[streamId];
  }

  // Clean up all state
  streamStopped[streamId] = true;
  clearMaxDurationTimer(streamId);
  delete streamRestartByDuration[streamId];
  delete streamConfigs[streamId];
  delete streamStartTime[streamId];
  delete streamFailCount[streamId];

  console.log(`[${streamId}] Stream deleted, all state cleaned up`);
  res.json({ success: true, message: 'Stream deleted and cleaned up' });
});

app.get('/status/:streamId', (req, res) => {
  const { streamId } = req.params;
  const isRunning = !!activeStreams[streamId];
  const isFailed = !isRunning && !streamConfigs[streamId] && (streamFailCount[streamId] >= 3);
  res.json({ streamId, running: isRunning, failed: isFailed });
});

app.post('/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const userId = req.headers['x-user-id'];
  const plan = (req.headers['x-user-plan'] || 'free').toLowerCase();
  const limit = STORAGE_LIMITS[plan] || STORAGE_LIMITS.free;
  const used = getUserDiskUsage(userId);
  if (used + req.file.size > limit) {
    fs.unlinkSync(req.file.path);
    const limitGB = (limit / (1024**3)).toFixed(0);
    return res.status(400).json({ error: `Storage limit reached. Your ${plan} plan allows ${limitGB}GB.` });
  }
  const metaFile = `/var/castloop/videos/${userId}/_meta.json`;
  let meta = {};
  if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const resolution = await getVideoResolution(req.file.path);
  meta[req.file.filename] = {
    originalName: req.body.originalName || req.file.originalname,
    width: resolution.width,
    height: resolution.height
  };
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  res.json({ success: true, videoPath: req.file.path, filename: req.file.filename, width: resolution.width, height: resolution.height });
});

app.get('/videos', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(400).json({ error: 'No user ID' });
  const dir = `/var/castloop/videos/${userId}/`;
  if (!fs.existsSync(dir)) return res.json([]);
  const metaFile = dir + '_meta.json';
  let meta = {};
  if (fs.existsSync(metaFile)) {
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (e) {}
  }
  const fileNames = fs.readdirSync(dir).filter(f => f !== '_meta.json');
  const files = await Promise.all(fileNames.map(async (f) => {
    const filePath = dir + f;
    const item = {
      filename: f,
      path: filePath,
      originalName: (typeof meta[f] === 'object' ? meta[f].originalName : meta[f]) || f,
      width: typeof meta[f] === 'object' ? meta[f].width : null,
      height: typeof meta[f] === 'object' ? meta[f].height : null,
      size: fs.statSync(filePath).size
    };
    const metadata = await getVideoMetadata(filePath);
    item.duration = metadata.duration;
    item.fps = metadata.fps;
    if (typeof meta[f] !== 'object') meta[f] = {};
    meta[f].duration = metadata.duration;
    meta[f].fps = metadata.fps;
    return item;
  }));
  try { fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2)); } catch (e) {}
  res.json(files);
});

async function renameVideoDisplayName(req, res) {
  const userId = req.headers['x-user-id'];
  const paramFilename = req.params.filename;
  const bodyFilename = req.body?.filename;
  const filename = paramFilename || bodyFilename;
  const { originalName } = req.body;
  if (!userId || !filename || !originalName)
    return res.status(400).json({ error: 'Missing parameters' });

  const safeFilename = path.basename(filename);
  if (safeFilename !== filename)
    return res.status(400).json({ error: 'Invalid filename' });

  const metaFile = `/var/castloop/videos/${userId}/_meta.json`;
  let meta = {};
  if (fs.existsSync(metaFile)) {
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch(e) {}
  }
  if (typeof meta[filename] !== 'object') meta[filename] = {};
  meta[filename].originalName = originalName;
  try {
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  } catch(e) {
    return res.status(500).json({ error: 'Failed to update metadata' });
  }

  const videoPath = `/var/castloop/videos/${userId}/${filename}`;
  try {
    const { data: userStreams, error: fetchError } = await supabase
      .from('streams')
      .select('id, video_paths')
      .eq('user_id', userId);
    if (!fetchError && userStreams && userStreams.length) {
      for (const stream of userStreams) {
        let paths;
        try {
          paths = typeof stream.video_paths === 'string'
            ? JSON.parse(stream.video_paths)
            : (stream.video_paths || []);
        } catch { paths = []; }
        if (!Array.isArray(paths)) continue;
        let changed = false;
        const updated = paths.map(item => {
          const p = typeof item === 'object' && item !== null ? item.path : item;
          if (p === videoPath) {
            changed = true;
            return { path: p, name: originalName };
          }
          return typeof item === 'object' ? item : { path: item, name: item.split('/').pop() };
        });
        if (changed) {
          await supabase.from('streams')
            .update({ video_paths: JSON.stringify(updated) })
            .eq('id', stream.id);
        }
      }
    }
  } catch(e) {
    console.error('[rename] Supabase update error:', e.message || e);
  }

  res.json({ success: true });
}

app.patch('/videos/:filename/rename', renameVideoDisplayName);
app.post('/videos/rename', renameVideoDisplayName);

app.get('/stream/:userId/:filename', (req, res) => {
  const userId = req.params.userId;
  const rawFilename = req.params.filename;
  if (!userId || !rawFilename) return res.status(400).json({ error: 'Missing parameters' });

  const filename = path.basename(rawFilename);
  if (filename !== rawFilename) return res.status(400).json({ error: 'Invalid filename' });

  const filePath = `/var/castloop/videos/${userId}/${filename}`;
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const ext = path.extname(filename).toLowerCase();
  const contentType = ext === '.mov' ? 'video/quicktime' : 'video/mp4';
  const range = req.headers.range;

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (!match) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).end();
    }

    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= fileSize || start > end) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).end();
    }

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType
    });

    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    'Content-Length': fileSize,
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes'
  });
  fs.createReadStream(filePath).pipe(res);
});

app.delete('/videos/:filename', (req, res) => {
  const userId = req.headers['x-user-id'];
  const filePath = `/var/castloop/videos/${userId}/${req.params.filename}`;
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  fs.unlinkSync(filePath);
  res.json({ success: true });
});


app.get('/storage', (req, res) => {
  const userId = req.headers['x-user-id'];
  const plan = (req.headers['x-user-plan'] || 'free').toLowerCase();
  if (!userId) return res.status(400).json({ error: 'No user ID' });
  const used = getUserDiskUsage(userId);
  const limit = STORAGE_LIMITS[plan] || STORAGE_LIMITS.free;
  res.json({ used, limit, plan });
});


app.get('/metrics', (req, res) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const cpus = os.cpus();

  res.json({
    cpu: {
      coreCount: cpus.length,
      cores: cpus.map((cpu, index) => ({
        core: index,
        model: cpu.model,
        speed: cpu.speed,
        times: cpu.times
      }))
    },
    memory: {
      total: totalMem,
      used: usedMem,
      free: freeMem
    },
    activeStreams: Object.keys(activeStreams).length,
    uptime: process.uptime()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeStreams: Object.keys(activeStreams).length });
});

// ── Upload Token ──────────────────────────────────────────────────────────────

const tokenUpload = multer({
  dest: '/tmp/castloop-uploads/',
  limits: { fileSize: 10 * 1024 * 1024 * 1024 }
});

app.post('/upload-token/validate', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ valid: false, error: 'Missing token' });

  const { data, error } = await supabaseAdmin
    .from('upload_tokens')
    .select('user_id, expires_at')
    .eq('token', token)
    .single();

  if (error || !data) return res.json({ valid: false, error: 'Invalid token' });
  if (new Date(data.expires_at) < new Date()) return res.json({ valid: false, error: 'Token expired' });

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('plan')
    .eq('id', data.user_id)
    .single();

  const plan = profile?.plan || 'free';
  const limit = STORAGE_LIMITS[plan] || STORAGE_LIMITS.free;
  const used = getUserDiskUsage(data.user_id);

  res.json({ valid: true, expiresAt: data.expires_at, plan, usedBytes: used, limitBytes: limit });
});

app.post('/upload-by-token', tokenUpload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const token = req.body.token;
  if (!token) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Missing token' });
  }

  const { data, error } = await supabaseAdmin
    .from('upload_tokens')
    .select('user_id, expires_at')
    .eq('token', token)
    .single();

  if (error || !data || new Date(data.expires_at) < new Date()) {
    fs.unlinkSync(req.file.path);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const userId = data.user_id;
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('plan')
    .eq('id', userId)
    .single();

  const plan = (profile?.plan || 'free').toLowerCase();
  const limit = STORAGE_LIMITS[plan] || STORAGE_LIMITS.free;
  const used = getUserDiskUsage(userId);

  if (used + req.file.size > limit) {
    fs.unlinkSync(req.file.path);
    const limitGB = (limit / (1024 ** 3)).toFixed(0);
    return res.status(400).json({ error: `Storage limit reached. Plan allows ${limitGB}GB.` });
  }

  const dir = `/var/castloop/videos/${userId}`;
  fs.mkdirSync(dir, { recursive: true });
  const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
  const ext = path.extname(req.file.originalname);
  const filename = unique + ext;
  const destPath = path.join(dir, filename);

  try {
    fs.renameSync(req.file.path, destPath);
  } catch {
    fs.copyFileSync(req.file.path, destPath);
    fs.unlinkSync(req.file.path);
  }

  const resolution = await getVideoResolution(destPath);
  const metaFile = path.join(dir, '_meta.json');
  let meta = {};
  if (fs.existsSync(metaFile)) {
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch {}
  }
  meta[filename] = {
    originalName: req.body.originalName || req.file.originalname,
    width: resolution.width,
    height: resolution.height
  };
  fs.writeFileSync(metaFile, JSON.stringify(meta));

  res.json({ success: true, filename, width: resolution.width, height: resolution.height });
});

app.post('/paddle-webhook', async (req, res) => {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[paddle-webhook] PADDLE_WEBHOOK_SECRET not set');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  const isTestMode = req.headers['x-test-mode'] === 'true' && req.headers['x-api-key'] === API_KEY;
  const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : JSON.stringify(req.body);

  if (!isTestMode) {
    const signatureHeader = req.headers['paddle-signature'];
    if (!signatureHeader) {
      return res.status(400).json({ error: 'Missing Paddle-Signature header' });
    }

    const parts = {};
    signatureHeader.split(';').forEach(part => {
      const [key, val] = part.split('=');
      if (key && val) parts[key.trim()] = val.trim();
    });

    const ts = parts['ts'];
    const h1 = parts['h1'];
    if (!ts || !h1) {
      return res.status(400).json({ error: 'Invalid Paddle-Signature header' });
    }

    const signedPayload = `${ts}:${rawBody}`;
    const expectedHash = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

    if (expectedHash !== h1) {
      console.error('[paddle-webhook] Signature mismatch');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } else {
    console.log('[paddle-webhook] Test mode: signature verification skipped');
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  if (event.event_type === 'transaction.completed') {
    const data = event.data || {};
    const email = data.customer?.email;

    const items = data.items || [];
    let priceId = null;
    for (const item of items) {
      const pid = item?.price?.id;
      if (pid && PRICE_PLAN_MAP[pid]) {
        priceId = pid;
        break;
      }
    }

    if (!priceId) {
      console.log('[paddle-webhook] No matching price_id found in transaction items');
      return res.json({ received: true });
    }

    const plan = PRICE_PLAN_MAP[priceId];

    if (email) {
      const { error } = await supabaseAdmin
        .from('profiles')
        .update({ plan })
        .eq('email', email);

      if (error) {
        console.error('[paddle-webhook] Supabase update error:', error.message);
        return res.status(500).json({ error: 'Failed to update profile' });
      }
      console.log(`[paddle-webhook] Updated user ${email} to plan "${plan}" (price: ${priceId})`);
    } else {
      console.log('[paddle-webhook] No email in data.customer, skipping profile update');
    }
  }

  res.json({ received: true });
});

// ── LemonSqueezy Webhook ────────────────────────────────────────────────────

const LEMON_VARIANT_PLAN_MAP = {
  // HD Lite
  '1454856': 'lite', '1454817': 'lite', '1454827': 'lite',
  // HD Basic
  '1454872': 'basic', '1454861': 'basic', '1454869': 'basic',
  // HD Pro
  '1454875': 'pro', '1454889': 'pro', '1454894': 'pro',
  // HD Business
  '1454917': 'business', '1454918': 'business', '1454919': 'business',
  // HD Enterprise
  '1455249': 'enterprise', '1455250': 'enterprise', '1455251': 'enterprise',
  // 4K Starter
  '1455280': '4k_starter', '1455281': '4k_starter', '1455282': '4k_starter',
  // 4K Plus
  '1455294': '4k_plus', '1455295': '4k_plus', '1455296': '4k_plus',
  // 4K Pro
  '1455308': '4k_pro', '1455309': '4k_pro', '1455310': '4k_pro',
};

app.post('/lemonsqueezy-webhook', async (req, res) => {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[lemon-webhook] LEMONSQUEEZY_WEBHOOK_SECRET not set');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : JSON.stringify(req.body);

  // Verify HMAC signature
  const signature = req.headers['x-signature'];
  if (!signature) {
    return res.status(400).json({ error: 'Missing X-Signature header' });
  }

  const expectedHash = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (expectedHash !== signature) {
    console.error('[lemon-webhook] Signature mismatch');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const eventName = event.meta?.event_name;
  const data = event.data?.attributes || {};
  const email = data.user_email || event.meta?.custom_data?.email;

  console.log(`[lemon-webhook] Event: ${eventName}, email: ${email || 'unknown'}`);

  if (!email) {
    console.log('[lemon-webhook] No email found, skipping');
    return res.json({ received: true });
  }

  if (eventName === 'subscription_created' || eventName === 'order_created') {
    const variantId = String(data.variant_id || data.first_subscription_item?.variant_id || data.first_order_item?.variant_id || '');
    let plan = LEMON_VARIANT_PLAN_MAP[variantId];

    // Fallback: extract plan from product_name if variant not mapped
    if (!plan && data.product_name) {
      const name = data.product_name.toLowerCase();
      if (name.includes('enterprise')) plan = 'enterprise';
      else if (name.includes('business')) plan = 'business';
      else if (name.includes('4k_pro') || name.includes('4k pro')) plan = '4k_pro';
      else if (name.includes('4k_plus') || name.includes('4k plus')) plan = '4k_plus';
      else if (name.includes('4k')) plan = '4k_starter';
      else if (name.includes('pro')) plan = 'pro';
      else if (name.includes('basic')) plan = 'basic';
      else if (name.includes('lite')) plan = 'lite';
    }

    if (!plan) {
      console.log(`[lemon-webhook] No plan mapped for variant ${variantId}, product: ${data.product_name}`);
      return res.json({ received: true });
    }

    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ plan })
      .eq('email', email);

    if (error) {
      console.error('[lemon-webhook] Supabase update error:', error.message);
      return res.status(500).json({ error: 'Failed to update profile' });
    }
    console.log(`[lemon-webhook] Upgraded ${email} to "${plan}"`);

  } else if (eventName === 'subscription_cancelled') {
    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ plan: 'free' })
      .eq('email', email);

    if (error) {
      console.error('[lemon-webhook] Supabase downgrade error:', error.message);
      return res.status(500).json({ error: 'Failed to downgrade profile' });
    }
    console.log(`[lemon-webhook] Downgraded ${email} to "free"`);
  }

  res.json({ received: true });
});

// ── Reconciler: sync activeStreams ↔ Supabase every 2 min ──────────────────

async function getMyServerId() {
  // Cache server ID after first lookup
  if (getMyServerId._cached) return getMyServerId._cached;

  // Try env var first
  if (process.env.SERVER_ID) {
    getMyServerId._cached = process.env.SERVER_ID;
    return getMyServerId._cached;
  }

  // Auto-detect from Supabase by matching this server's IP
  try {
    const ifaces = os.networkInterfaces();
    const ips = [];
    for (const name in ifaces) {
      for (const iface of ifaces[name]) {
        if (!iface.internal && iface.family === 'IPv4') ips.push(iface.address);
      }
    }

    if (ips.length) {
      const { data } = await supabaseAdmin
        .from('servers')
        .select('id')
        .in('ip', ips)
        .limit(1)
        .single();
      if (data?.id) {
        getMyServerId._cached = data.id;
        console.log(`[reconciler] Auto-detected server ID: ${data.id}`);
        return data.id;
      }
    }
  } catch (e) {
    // Ignore lookup errors
  }

  return null;
}

async function reconcile() {
  // Don't run until startup recovery is complete
  if (!recoverRunningStreamsOnStartup._done) {
    console.log('[reconciler] Waiting for startup recovery to finish...');
    return;
  }

  try {
    const serverId = await getMyServerId();

    // 1. Get streams Supabase thinks are running on this server
    let query = supabaseAdmin
      .from('streams')
      .select('id')
      .eq('status', 'running');

    if (serverId) {
      query = query.eq('server_id', serverId);
    }

    const { data: dbRunning, error } = await query;
    if (error) {
      console.error('[reconciler] Supabase query error:', error.message);
      return;
    }

    const dbRunningIds = new Set((dbRunning || []).map(s => String(s.id)));
    const activeIds = new Set(Object.keys(activeStreams));

    // 2. Supabase says running, but no FFmpeg process → mark stopped
    let fixedStale = 0;
    for (const id of dbRunningIds) {
      if (!activeIds.has(id)) {
        console.log(`[reconciler] Stale stream ${id}: running in DB but no FFmpeg. Marking stopped.`);
        await supabaseAdmin.from('streams').update({ status: 'stopped' }).eq('id', id);
        fixedStale++;
      }
    }

    // 3. FFmpeg running, but Supabase doesn't say running → kill orphan
    let killedOrphans = 0;
    for (const id of activeIds) {
      if (!dbRunningIds.has(id)) {
        console.log(`[reconciler] Orphan FFmpeg ${id}: process alive but not running in DB. Killing.`);
        try {
          activeStreams[id].kill('SIGTERM');
        } catch (e) { /* already dead */ }
        delete activeStreams[id];
        streamStopped[id] = true;
        clearMaxDurationTimer(id);
        delete streamRestartByDuration[id];
        delete streamConfigs[id];
        delete streamStartTime[id];
        delete streamFailCount[id];
        killedOrphans++;
      }
    }

    if (fixedStale || killedOrphans) {
      console.log(`[reconciler] Fixed ${fixedStale} stale, killed ${killedOrphans} orphans.`);
    }
  } catch (e) {
    console.error('[reconciler] Error:', e.message);
  }
}

app.listen(3000, () => {
  console.log('Castloop Stream API running on port 3000');
  recoverRunningStreamsOnStartup();

  // Start reconciler after 30s, then every 2 min
  setTimeout(() => {
    reconcile();
    setInterval(reconcile, 2 * 60 * 1000);
  }, 30000);
});
