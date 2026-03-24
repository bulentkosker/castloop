const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const API_KEY = 'castloop-secret-2024';
app.use(cors());
app.use(express.json());

const SUPABASE_URL = 'https://pdttjblnvxoitskhdtro.supabase.co';
const SUPABASE_KEY = 'sb_publishable_vxcNOoezd_FKxKWmWj-rZQ_w3IrSMaG';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use((req, res, next) => {
  if (req.path === '/health') return next();
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
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [raw];
    } catch {
      return [raw];
    }
  }
  return [];
}

async function recoverRunningStreamsOnStartup() {
  try {
    console.log('[startup-recovery] Fetching running streams from Supabase...');
    const { data, error } = await supabase
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

      const parsedDuration = Number(stream.max_duration ?? stream.maxDuration);
      const safeMaxDuration = Number.isFinite(parsedDuration) && parsedDuration > 0
        ? Math.floor(parsedDuration)
        : 43200;

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
        await supabase.from('streams').update({ status: 'running' }).eq('id', streamId);
      } catch (updateErr) {
        console.error('[startup-recovery] Failed to update stream status:', updateErr.message || updateErr);
      }
      recovered += 1;

      console.log('[startup-recovery] Recovered stream:', streamId, 'server_id=', serverId);
    }

    console.log('[startup-recovery] Completed. recovered=' + recovered + ', skipped=' + skipped);
  } catch (err) {
    console.error('[startup-recovery] Unexpected error:', err.message || err);
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

  let ffmpegArgs;
  if (videoPaths.length === 1) {
    ffmpegArgs = [
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
   ffmpegArgs = [
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

app.listen(3000, () => {
  console.log('Castloop Stream API running on port 3000');
  recoverRunningStreamsOnStartup();
});
