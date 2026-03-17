const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const API_KEY = 'castloop-secret-2024';
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userId = req.headers['x-user-id'];
    if (!userId) return cb(new Error('No user ID'));
    const dir = `/var/castreo/videos/${userId}`;
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
  const dir = `/var/castreo/videos/${userId}/`;
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir)
    .filter(f => f !== '_meta.json')
    .reduce((total, f) => {
      try { return total + fs.statSync(dir + f).size; } catch { return total; }
    }, 0);
}

const activeStreams = {};
const streamConfigs = {};
const streamStopped = {};
const streamStartTime = {};
const streamFailCount = {};

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

  ffmpeg.stderr.on('data', (data) => console.log(`[${streamId}] ${data}`));

  ffmpeg.on('close', (code) => {
    console.log(`[${streamId}] Stream ended with code ${code}`);
    delete activeStreams[streamId];

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
  const { streamId, rtmpUrl, streamKey, videoPaths, videoPath } = req.body;
  if (!streamId || !rtmpUrl || !streamKey)
    return res.status(400).json({ error: 'Missing parameters' });

  const paths = (typeof videoPaths === 'string' ? JSON.parse(videoPaths) : videoPaths)
    || (videoPath ? [videoPath] : null);
  if (!paths || !paths.length)
    return res.status(400).json({ error: 'No video path provided' });

  if (activeStreams[streamId])
    return res.status(400).json({ error: 'Stream already running' });

  streamConfigs[streamId] = { rtmpUrl, streamKey, videoPaths: paths };
  streamStopped[streamId] = false;
  streamFailCount[streamId] = 0;
  startFFmpeg(streamId);
  res.json({ success: true, message: 'Stream started' });
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

app.post('/upload', upload.single('video'), (req, res) => {
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
  const metaFile = `/var/castreo/videos/${userId}/_meta.json`;
  let meta = {};
  if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  meta[req.file.filename] = req.body.originalName || req.file.originalname;
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  res.json({ success: true, videoPath: req.file.path, filename: req.file.filename });
});

app.get('/videos', (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(400).json({ error: 'No user ID' });
  const dir = `/var/castreo/videos/${userId}/`;
  if (!fs.existsSync(dir)) return res.json([]);
  const metaFile = dir + '_meta.json';
  let meta = {};
  if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const files = fs.readdirSync(dir)
    .filter(f => f !== '_meta.json')
    .map(f => ({
      filename: f,
      path: dir + f,
      originalName: meta[f] || f,
      size: fs.statSync(dir + f).size
    }));
  res.json(files);
});

app.delete('/videos/:filename', (req, res) => {
  const userId = req.headers['x-user-id'];
  const filePath = `/var/castreo/videos/${userId}/${req.params.filename}`;
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeStreams: Object.keys(activeStreams).length });
});

app.listen(3000, () => console.log('Castreo Stream API running on port 3000'));
