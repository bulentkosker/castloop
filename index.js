// test deploy — trigger badge sync
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
const sharp = require('sharp');

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
  if (req.path.startsWith('/auth/youtube')) return next();
  if (req.path.startsWith('/badges/')) return next();
  if (req.path === '/upload-token/validate') return next();
  if (req.path === '/upload-by-token') return next();
  const streamQueryKey = (req.path.startsWith('/stream/') || req.path.startsWith('/thumbnail/')) ? req.query.apiKey : null;
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
      '-show_entries', 'format=duration,bit_rate',
      '-show_entries', 'stream=r_frame_rate,bit_rate,codec_name',
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
        // Bitrate: prefer stream-level, fall back to format-level (bits/sec)
        const bitrate = parseInt(stream?.bit_rate, 10) || parseInt(format.bit_rate, 10) || null;
        const codec = stream?.codec_name || null;
        resolve({ duration, fps, bitrate, codec });
      } catch (e) {
        resolve({ duration: null, fps: null, bitrate: null, codec: null });
      }
    });
  });
}

// --- Bitrate normalization queue ---
const normalizeQueue = [];
let normalizeRunning = false;
const normalizeProgress = {}; // { filename: { percent } }
const normalizingFiles = new Set(); // filenames currently normalizing or queued
let normalizeCurrentFile = null;
let normalizeCurrentProcess = null;

function enqueueNormalize(filePath, width, height, bitrateBps, metaFile, filename) {
  const bitrateMbps = bitrateBps ? bitrateBps / 1_000_000 : 0;
  if (bitrateMbps <= 30) {
    console.log(`[normalize] Skip ${filename}: bitrate ${bitrateMbps.toFixed(1)} Mbps <= 30 Mbps`);
    return;
  }

  // Determine target bitrate based on resolution
  let targetKbps;
  if (width >= 3840 && height >= 2160) {
    targetKbps = 22000; // 4K → 22 Mbps
  } else {
    targetKbps = 8000;  // 1080p and below → 8 Mbps
  }

  console.log(`[normalize] Queued ${filename}: ${bitrateMbps.toFixed(1)} Mbps → target ${targetKbps / 1000} Mbps`);
  normalizingFiles.add(filename);
  normalizeProgress[filename] = { percent: 0 };
  normalizeQueue.push({ filePath, targetKbps, metaFile, filename });
  processNormalizeQueue();
}

async function processNormalizeQueue() {
  if (normalizeRunning || normalizeQueue.length === 0) return;
  normalizeRunning = true;

  const job = normalizeQueue.shift();
  const { filePath, targetKbps, metaFile, filename } = job;
  const tmpOut = filePath + '.normalizing.mp4';

  console.log(`[normalize] Starting ${filename} (target ${targetKbps}k, queue: ${normalizeQueue.length} remaining)`);

  // Get duration for progress calculation
  const preMeta = await getVideoMetadata(filePath);
  const totalDuration = preMeta.duration || 0;

  normalizeCurrentFile = filename;

  try {
    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-y', '-i', filePath,
        '-c:v', 'libx264', '-preset', 'veryfast',
        '-b:v', `${targetKbps}k`, '-maxrate', `${Math.round(targetKbps * 1.2)}k`, '-bufsize', `${targetKbps * 2}k`,
        '-g', '48',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        tmpOut,
      ]);
      normalizeCurrentProcess = ff;
      let stderr = '';
      ff.stderr.on('data', d => {
        stderr += d.toString();
        // Parse time= from FFmpeg stderr for progress
        if (totalDuration > 0) {
          const m = d.toString().match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
          if (m) {
            const secs = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 100;
            normalizeProgress[filename].percent = Math.min(99, Math.round(secs / totalDuration * 100));
          }
        }
      });
      ff.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg exit ${code}: ${stderr.slice(-300)}`));
      });
      ff.on('error', reject);
    });

    // Verify output exists and is valid
    if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size < 1000) {
      throw new Error('Output file missing or too small');
    }

    // Replace original with normalized version
    fs.renameSync(tmpOut, filePath);
    console.log(`[normalize] Replaced ${filename} with normalized version`);

    // Update _meta.json
    const newMeta = await getVideoMetadata(filePath);
    const resolution = await getVideoResolution(filePath);
    try {
      let meta = {};
      if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (!meta[filename]) meta[filename] = {};
      meta[filename].bitrate = newMeta.bitrate;
      meta[filename].width = resolution.width;
      meta[filename].height = resolution.height;
      meta[filename].normalized = true;
      const quality = checkVideoQuality(resolution.width, resolution.height, newMeta.bitrate);
      meta[filename].low_quality = quality.low_quality;
      fs.writeFileSync(metaFile, JSON.stringify(meta));
    } catch (e) {
      console.error(`[normalize] Failed to update meta for ${filename}:`, e.message);
    }

    normalizingFiles.delete(filename);
    delete normalizeProgress[filename];
    console.log(`[normalize] Done ${filename}: new bitrate ${newMeta.bitrate ? (newMeta.bitrate / 1_000_000).toFixed(1) : '?'} Mbps`);
  } catch (err) {
    console.error(`[normalize] Failed ${filename}:`, err.message);
    normalizingFiles.delete(filename);
    delete normalizeProgress[filename];
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
  }

  normalizeCurrentFile = null;
  normalizeCurrentProcess = null;
  normalizeRunning = false;
  processNormalizeQueue();
}

// Generate a thumbnail for an uploaded video and update _meta.json
function generateUploadThumbnail(videoPath, metaFile, filename) {
  const thumbName = filename.replace(/\.[^.]+$/, '') + '_thumb.jpg';
  const thumbPath = path.join(path.dirname(videoPath), thumbName);

  const ff = spawn('ffmpeg', [
    '-y', '-ss', '1', '-i', videoPath, '-vframes', '1',
    '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
    thumbPath,
  ]);
  let stderr = '';
  ff.stderr.on('data', d => { stderr += d.toString(); });
  ff.on('close', code => {
    if (code !== 0) {
      console.error(`[thumbnail] Failed for ${filename}: ${stderr.slice(-200)}`);
      return;
    }
    // Update _meta.json with thumbnail_path
    try {
      let meta = {};
      if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (meta[filename]) {
        meta[filename].thumbnail_path = thumbPath;
        fs.writeFileSync(metaFile, JSON.stringify(meta));
      }
    } catch (e) {
      console.error(`[thumbnail] Meta update failed for ${filename}:`, e.message);
    }
    console.log(`[thumbnail] Generated ${thumbName}`);
  });
  ff.on('error', err => {
    console.error(`[thumbnail] Spawn error for ${filename}:`, err.message);
  });
}

// Check video quality and return warning if below recommended thresholds
function checkVideoQuality(width, height, bitrateBps) {
  const bitrateMbps = bitrateBps ? bitrateBps / 1_000_000 : null;
  const w = width || 0;
  const h = height || 0;

  // 720p and below: unsupported
  if (h > 0 && h < 1080) {
    return { low_quality: true, quality_warning: 'unsupported_resolution', bitrate_mbps: bitrateMbps };
  }
  // 4K: minimum 15 Mbps
  if (w >= 3840 && h >= 2160 && bitrateMbps !== null && bitrateMbps < 15) {
    return { low_quality: true, quality_warning: 'low_bitrate_4k', bitrate_mbps: bitrateMbps };
  }
  // 1080p: minimum 6 Mbps
  if (w >= 1920 && h >= 1080 && bitrateMbps !== null && bitrateMbps < 6) {
    return { low_quality: true, quality_warning: 'low_bitrate_1080p', bitrate_mbps: bitrateMbps };
  }
  return { low_quality: false, quality_warning: null, bitrate_mbps: bitrateMbps };
}

const activeStreams = {};
const streamConfigs = {};
const streamStopped = {};
const streamStartTime = {};
const streamFailCount = {};
const streamMaxDurationTimers = {};

// ── WhatsApp notification via Twilio ──────────────────────────────────────
async function sendWhatsAppAlert(streamId) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) return;

  try {
    // Get stream info
    const { data: stream } = await supabaseAdmin
      .from('streams')
      .select('name, user_id')
      .eq('id', streamId)
      .single();
    if (!stream?.user_id) return;

    // Get user profile
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('phone, whatsapp_notifications')
      .eq('id', stream.user_id)
      .single();

    if (!profile?.phone || profile.whatsapp_notifications === false) return;

    const to = `whatsapp:${profile.phone}`;
    const body = `🔴 Castloop: "${stream.name || streamId}" yayınınız düştü. Dashboard'dan kontrol edin: https://castloop.tv/dashboard.html`;

    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: from, To: to, Body: body }),
    });

    const result = await resp.json();
    if (result.sid) {
      console.log(`[whatsapp] Alert sent to ${profile.phone} for stream ${streamId}`);
    } else {
      console.error(`[whatsapp] Failed:`, result.message || result);
    }
  } catch (e) {
    console.error(`[whatsapp] Error sending alert for ${streamId}:`, e.message);
  }
}
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
      sendWhatsAppAlert(streamId);
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

const SERVER_PLAN_LIMITS = { free: 1, lite: 1, basic: 2, pro: 4, business: 8, enterprise: 12, '4k_starter': 1, '4k_plus': 4, '4k_pro': 8 };

app.post('/start', async (req, res) => {
  const { streamId, rtmpUrl, streamKey, videoPaths, videoPath, maxDuration } = req.body;
  if (!streamId || !rtmpUrl || !streamKey)
    return res.status(400).json({ error: 'Missing parameters' });

  const paths = (typeof videoPaths === 'string' ? JSON.parse(videoPaths) : videoPaths)
    || (videoPath ? [videoPath] : null);
  if (!paths || !paths.length)
    return res.status(400).json({ error: 'No video path provided' });

  if (activeStreams[streamId])
    return res.status(400).json({ error: 'Stream already running' });

  // Server-side plan limit check
  try {
    const { data: stream } = await supabaseAdmin.from('streams').select('user_id').eq('id', streamId).single();
    if (stream?.user_id) {
      const { data: profile } = await supabaseAdmin.from('profiles').select('plan').eq('id', stream.user_id).single();
      const plan = (profile?.plan || 'free').toLowerCase();
      const limit = SERVER_PLAN_LIMITS[plan] || 1;

      const { data: running } = await supabaseAdmin.from('streams')
        .select('id', { count: 'exact', head: false })
        .eq('user_id', stream.user_id)
        .eq('status', 'running');

      const runningCount = running?.length || 0;
      if (runningCount >= limit) {
        return res.status(403).json({ error: `Plan limit reached (${runningCount}/${limit}). Upgrade your plan.` });
      }
    }
  } catch (e) {
    console.warn('[start] Plan check failed, allowing start:', e.message);
  }

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
  const metadata = await getVideoMetadata(req.file.path);
  const quality = checkVideoQuality(resolution.width, resolution.height, metadata.bitrate);
  meta[req.file.filename] = {
    originalName: req.body.originalName || req.file.originalname,
    width: resolution.width,
    height: resolution.height,
    bitrate: metadata.bitrate,
    codec: metadata.codec,
    low_quality: quality.low_quality
  };
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  res.json({
    success: true, videoPath: req.file.path, filename: req.file.filename,
    width: resolution.width, height: resolution.height, codec: metadata.codec,
    bitrate_mbps: quality.bitrate_mbps, low_quality: quality.low_quality, quality_warning: quality.quality_warning,
  });

  // Non-blocking post-upload tasks
  generateUploadThumbnail(req.file.path, metaFile, req.file.filename);
  enqueueNormalize(req.file.path, resolution.width, resolution.height, metadata.bitrate, metaFile, req.file.filename);
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
  const fileNames = fs.readdirSync(dir).filter(f => f !== '_meta.json' && !f.endsWith('_thumb.jpg') && !f.includes('.normalizing.'));
  const files = await Promise.all(fileNames.map(async (f) => {
    const filePath = dir + f;
    const item = {
      filename: f,
      path: filePath,
      originalName: (typeof meta[f] === 'object' ? meta[f].originalName : meta[f]) || f,
      width: typeof meta[f] === 'object' ? meta[f].width : null,
      height: typeof meta[f] === 'object' ? meta[f].height : null,
      size: fs.statSync(filePath).size,
      folder_id: typeof meta[f] === 'object' ? meta[f].folder_id || null : null,
    };
    const metadata = await getVideoMetadata(filePath);
    item.duration = metadata.duration;
    item.fps = metadata.fps;
    item.bitrate = metadata.bitrate;
    item.codec = metadata.codec;
    const quality = checkVideoQuality(item.width, item.height, metadata.bitrate);
    item.bitrate_mbps = quality.bitrate_mbps;
    item.low_quality = quality.low_quality;
    // Thumbnail: check if exists on disk
    const thumbName = f.replace(/\.[^.]+$/, '') + '_thumb.jpg';
    const thumbPath = dir + thumbName;
    if (fs.existsSync(thumbPath)) {
      item.thumbnail_path = thumbPath;
    } else {
      // Generate missing thumbnail in background
      generateUploadThumbnail(filePath, metaFile, f);
    }
    if (typeof meta[f] !== 'object') meta[f] = {};
    meta[f].duration = metadata.duration;
    meta[f].fps = metadata.fps;
    meta[f].bitrate = metadata.bitrate;
    meta[f].codec = metadata.codec;
    meta[f].low_quality = quality.low_quality;
    // Normalize status: purely in-memory, no race conditions
    if (normalizingFiles.has(f)) {
      item.normalizing = true;
      item.normalize_percent = normalizeProgress[f]?.percent || 0;
    }
    return item;
  }));
  try { fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2)); } catch (e) {}
  res.json(files);
});

app.get('/normalize-progress/:filename', (req, res) => {
  const filename = req.params.filename;
  if (normalizingFiles.has(filename)) {
    return res.json({ status: 'running', percent: normalizeProgress[filename]?.percent || 0 });
  }
  res.json({ status: 'idle', percent: 0 });
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

// Serve badge PNG files for drag-and-drop preview
app.get('/badges/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  if (filename !== req.params.filename) return res.status(400).json({ error: 'Invalid filename' });
  const filePath = path.join(BADGE_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Badge not found' });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  fs.createReadStream(filePath).pipe(res);
});

app.get('/thumbnail/:userId/:filename', (req, res) => {
  const userId = req.params.userId;
  const rawFilename = req.params.filename;
  if (!userId || !rawFilename) return res.status(400).json({ error: 'Missing parameters' });

  const filename = path.basename(rawFilename);
  if (filename !== rawFilename) return res.status(400).json({ error: 'Invalid filename' });

  const thumbName = filename.replace(/\.[^.]+$/, '') + '_thumb.jpg';
  const thumbPath = `/var/castloop/videos/${userId}/${thumbName}`;
  if (!fs.existsSync(thumbPath)) return res.status(404).json({ error: 'Thumbnail not found' });

  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(thumbPath).pipe(res);
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
  const filename = req.params.filename;
  const dir = `/var/castloop/videos/${userId}`;
  const filePath = `${dir}/${filename}`;
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  // Kill normalize FFmpeg if this file is being normalized
  if (normalizeCurrentFile === filename && normalizeCurrentProcess) {
    console.log(`[normalize] Killing FFmpeg for deleted file: ${filename}`);
    normalizeCurrentProcess.kill('SIGTERM');
    normalizeCurrentFile = null;
    normalizeCurrentProcess = null;
    normalizeRunning = false;
  }
  // Remove from normalize queue if queued
  const qIdx = normalizeQueue.findIndex(j => j.filename === filename);
  if (qIdx !== -1) normalizeQueue.splice(qIdx, 1);
  normalizingFiles.delete(filename);
  delete normalizeProgress[filename];

  // Delete main video file
  fs.unlinkSync(filePath);

  // Delete .normalizing.mp4 temp file
  const tmpFile = filePath + '.normalizing.mp4';
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);

  // Delete thumbnail
  const thumbName = filename.replace(/\.[^.]+$/, '') + '_thumb.jpg';
  const thumbPath = `${dir}/${thumbName}`;
  if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

  // Remove from _meta.json
  const metaFile = `${dir}/_meta.json`;
  try {
    if (fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      delete meta[filename];
      fs.writeFileSync(metaFile, JSON.stringify(meta));
    }
  } catch {}

  console.log(`[delete] Cleaned up ${filename} (video + thumb + meta + normalize)`);
  res.json({ success: true });

  // Resume queue if we killed the active job
  processNormalizeQueue();
});


// ── Video Folders ────────────────────────────────────────────────────────────

app.get('/folders', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(400).json({ error: 'x-user-id required' });
  const { data, error } = await supabaseAdmin.from('video_folders')
    .select('*').eq('user_id', userId).order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/folders', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const { name } = req.body;
  if (!userId || !name) return res.status(400).json({ error: 'user_id and name required' });
  const { data, error } = await supabaseAdmin.from('video_folders')
    .insert({ user_id: userId, name }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/folders/:folderId', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(400).json({ error: 'x-user-id required' });

  // Clear folder_id from videos in this folder (don't delete videos)
  const dir = `/var/castloop/videos/${userId}/`;
  const metaFile = dir + '_meta.json';
  try {
    if (fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      let changed = false;
      for (const [, entry] of Object.entries(meta)) {
        if (entry?.folder_id === req.params.folderId) {
          delete entry.folder_id;
          changed = true;
        }
      }
      if (changed) fs.writeFileSync(metaFile, JSON.stringify(meta));
    }
  } catch {}

  const { error } = await supabaseAdmin.from('video_folders')
    .delete().eq('id', req.params.folderId).eq('user_id', userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.patch('/videos/:filename/folder', (req, res) => {
  const userId = req.headers['x-user-id'];
  const filename = req.params.filename;
  const { folderId } = req.body;
  if (!userId) return res.status(400).json({ error: 'x-user-id required' });

  const metaFile = `/var/castloop/videos/${userId}/_meta.json`;
  try {
    let meta = {};
    if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (!meta[filename]) return res.status(404).json({ error: 'Video not found' });
    if (folderId) {
      meta[filename].folder_id = folderId;
    } else {
      delete meta[filename].folder_id;
    }
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Bulk Video Operations ─────────────────────────────────────────────────

app.post('/videos/bulk-move', (req, res) => {
  const userId = req.headers['x-user-id'];
  const { filenames, folderId } = req.body;
  if (!userId) return res.status(400).json({ error: 'x-user-id required' });
  if (!Array.isArray(filenames) || !filenames.length) return res.status(400).json({ error: 'filenames array required' });

  const metaFile = `/var/castloop/videos/${userId}/_meta.json`;
  try {
    let meta = {};
    if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    let moved = 0;
    for (const filename of filenames) {
      if (!meta[filename]) continue;
      if (folderId) {
        meta[filename].folder_id = folderId;
      } else {
        delete meta[filename].folder_id;
      }
      moved++;
    }
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    res.json({ success: true, moved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/videos/bulk-delete', (req, res) => {
  const userId = req.headers['x-user-id'];
  const { filenames } = req.body;
  if (!userId) return res.status(400).json({ error: 'x-user-id required' });
  if (!Array.isArray(filenames) || !filenames.length) return res.status(400).json({ error: 'filenames array required' });

  const dir = `/var/castloop/videos/${userId}`;
  const metaFile = `${dir}/_meta.json`;
  let meta = {};
  try { if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch {}

  let deleted = 0;
  for (const filename of filenames) {
    const filePath = `${dir}/${filename}`;
    if (!fs.existsSync(filePath)) continue;

    // Kill normalize if active
    if (normalizeCurrentFile === filename && normalizeCurrentProcess) {
      normalizeCurrentProcess.kill('SIGTERM');
      normalizeCurrentFile = null;
      normalizeCurrentProcess = null;
      normalizeRunning = false;
    }
    const qIdx = normalizeQueue.findIndex(j => j.filename === filename);
    if (qIdx !== -1) normalizeQueue.splice(qIdx, 1);
    normalizingFiles.delete(filename);
    delete normalizeProgress[filename];

    fs.unlinkSync(filePath);
    const tmpFile = filePath + '.normalizing.mp4';
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    const thumbName = filename.replace(/\.[^.]+$/, '') + '_thumb.jpg';
    const thumbPath = `${dir}/${thumbName}`;
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    delete meta[filename];
    deleted++;
  }

  try { fs.writeFileSync(metaFile, JSON.stringify(meta)); } catch {}
  console.log(`[bulk-delete] Deleted ${deleted}/${filenames.length} files for user ${userId}`);
  res.json({ success: true, deleted });
  processNormalizeQueue();
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
  const metadata = await getVideoMetadata(destPath);
  const quality = checkVideoQuality(resolution.width, resolution.height, metadata.bitrate);
  const metaFile = path.join(dir, '_meta.json');
  let meta = {};
  if (fs.existsSync(metaFile)) {
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch {}
  }
  meta[filename] = {
    originalName: req.body.originalName || req.file.originalname,
    width: resolution.width,
    height: resolution.height,
    bitrate: metadata.bitrate,
    codec: metadata.codec,
    low_quality: quality.low_quality
  };
  fs.writeFileSync(metaFile, JSON.stringify(meta));

  res.json({
    success: true, filename, width: resolution.width, height: resolution.height, codec: metadata.codec,
    bitrate_mbps: quality.bitrate_mbps, low_quality: quality.low_quality, quality_warning: quality.quality_warning,
  });

  // Non-blocking post-upload tasks
  generateUploadThumbnail(destPath, metaFile, filename);
  enqueueNormalize(destPath, resolution.width, resolution.height, metadata.bitrate, metaFile, filename);
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
      try {
        await updateUserPlan(email, plan);
      } catch (e) {
        console.error('[paddle-webhook] ' + e.message);
        return res.status(500).json({ error: 'Failed to update profile' });
      }
    } else {
      console.log('[paddle-webhook] No email in data.customer, skipping profile update');
    }
  }

  res.json({ received: true });
});

async function updateUserPlan(email, plan) {
  // Look up user by email using Supabase Auth Admin API
  const { data, error: lookupErr } = await supabaseAdmin.auth.admin.listUsers({
    filter: { email: email },
    page: 1,
    perPage: 1,
  });

  // Fallback: if filter not supported, search manually
  let userId;
  if (data?.users?.length) {
    userId = data.users[0].id;
  } else {
    // Brute search fallback (paginated)
    let page = 1;
    while (!userId) {
      const { data: batch, error: batchErr } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 100 });
      if (batchErr || !batch?.users?.length) break;
      const found = batch.users.find(u => u.email === email);
      if (found) { userId = found.id; break; }
      if (batch.users.length < 100) break;
      page++;
    }
  }

  if (!userId) throw new Error(`No user found with email: ${email}`);

  // Upsert profile: update if exists, insert if not
  const { error } = await supabaseAdmin
    .from('profiles')
    .upsert({ id: userId, plan }, { onConflict: 'id' });

  if (error) throw new Error('Profile update failed: ' + error.message);
  console.log(`[webhook] Updated user ${email} (${userId}) to plan "${plan}"`);
}

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
  console.log('[lemon-webhook] ── REQUEST RECEIVED ──');
  console.log('[lemon-webhook] Headers:', JSON.stringify({
    'content-type': req.headers['content-type'],
    'x-signature': req.headers['x-signature'] ? '(present)' : '(missing)',
    'x-event-name': req.headers['x-event-name'] || 'none',
  }));
  console.log('[lemon-webhook] Body type:', typeof req.body, req.body instanceof Buffer ? 'Buffer' : 'other', 'length:', req.body?.length || 0);

  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[lemon-webhook] LEMONSQUEEZY_WEBHOOK_SECRET not set');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : JSON.stringify(req.body);
  console.log('[lemon-webhook] Raw body (first 500 chars):', rawBody.slice(0, 500));

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

  console.log(`[lemon-webhook] Event: ${eventName}, email: ${email || 'unknown'}, variant_id: ${data.variant_id || 'none'}, product: ${data.product_name || 'none'}`);

  if (!email) {
    console.log('[lemon-webhook] No email found. data keys:', Object.keys(data).join(', '));
    console.log('[lemon-webhook] meta:', JSON.stringify(event.meta || {}));
    return res.json({ received: true });
  }

  if (eventName === 'subscription_created' || eventName === 'order_created') {
    const variantId = String(data.variant_id || data.first_subscription_item?.variant_id || data.first_order_item?.variant_id || '');
    console.log(`[lemon-webhook] Looking up variant: ${variantId}`);
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

    try {
      await updateUserPlan(email, plan);
    } catch (e) {
      console.error('[lemon-webhook] ' + e.message);
      return res.status(500).json({ error: 'Failed to update profile' });
    }

  } else if (eventName === 'subscription_cancelled') {
    try {
      await updateUserPlan(email, 'free');
    } catch (e) {
      console.error('[lemon-webhook] ' + e.message);
      return res.status(500).json({ error: 'Failed to downgrade profile' });
    }
  }

  res.json({ received: true });
});

// ── YouTube OAuth & Broadcast Management ────────────────────────────────────

const YT_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const YT_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const YT_REDIRECT_URI = 'https://api.castloop.tv/auth/youtube/callback';
const YT_SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.force-ssl',
].join(' ');

async function getYtAccount(userId, accountId) {
  if (accountId) {
    const { data } = await supabaseAdmin.from('youtube_accounts')
      .select('*').eq('id', accountId).eq('user_id', userId).single();
    return data;
  }
  // Fallback: first account
  const { data } = await supabaseAdmin.from('youtube_accounts')
    .select('*').eq('user_id', userId).limit(1).single();
  return data;
}

async function refreshYouTubeToken(accountId) {
  const { data: account } = await supabaseAdmin
    .from('youtube_accounts')
    .select('refresh_token')
    .eq('id', accountId)
    .single();

  if (!account?.refresh_token) return null;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: YT_CLIENT_ID,
      client_secret: YT_CLIENT_SECRET,
      refresh_token: account.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  const tokens = await resp.json();
  if (!tokens.access_token) return null;

  await supabaseAdmin
    .from('youtube_accounts')
    .update({ access_token: tokens.access_token })
    .eq('id', accountId);

  return tokens.access_token;
}

async function ytApi(userId, url, options = {}, accountId) {
  const account = await getYtAccount(userId, accountId);
  if (!account) throw new Error('No YouTube account found');

  let token = account.access_token;
  let resp = await fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });

  // Token expired — refresh and retry once
  if (resp.status === 401) {
    token = await refreshYouTubeToken(account.id);
    if (!token) throw new Error('YouTube token refresh failed');
    resp = await fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    });
  }

  return resp.json();
}

// Badge config: PNG file → position on thumbnail
const BADGE_DIR = path.join(__dirname, 'badges');
// Startup check: verify badge directory exists
if (fs.existsSync(BADGE_DIR)) {
  const badgeFiles = fs.readdirSync(BADGE_DIR).filter(f => f.endsWith('.png'));
  console.log(`[badges] Directory found: ${BADGE_DIR} (${badgeFiles.length} PNG files: ${badgeFiles.join(', ')})`);
} else {
  console.error(`[badges] WARNING: Badge directory missing: ${BADGE_DIR} — run: cd /root/castloop && git pull`);
}
const BADGE_CONFIG = {
  'live':           { file: 'badge_live.png',           position: 'right' },
  'live_streaming': { file: 'live-stream.png', position: 'right' },
  '247_live':       { file: 'badge_247_live.png',       position: 'right' },
  'nonstop':        { file: 'badge_nonstop.png',        position: 'right' },
  'inf_247':        { file: 'badge_inf_247.png',        position: 'right' },
  '4k_uhd':        { file: '4k icon.png',               position: 'left' },
  'full_hd':       { file: 'full-hd-icon.png',         position: 'left' },
};

// Generate thumbnail from video frame + optional badge overlays
// badges: array of badge keys, e.g. ['4k_uhd', '247_live']
async function generateThumbnail(videoPath, badges) {
  const ts = Date.now();
  const tmpFrame = `/tmp/thumb_frame_${ts}.jpg`;
  const tmpOut = `/tmp/thumb_final_${ts}.jpg`;

  console.log(`[thumbnail] Starting generation: video=${videoPath}, badges=${JSON.stringify(badges)}`);

  // Check video file exists
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }
  console.log(`[thumbnail] Video file exists, size=${fs.statSync(videoPath).size} bytes`);

  // Extract frame at 30s with FFmpeg
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-ss', '30', '-i', videoPath, '-vframes', '1',
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
      tmpFrame,
    ]);
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('close', code => {
      if (code === 0) {
        console.log(`[thumbnail] FFmpeg frame extracted: ${tmpFrame}`);
        resolve();
      } else {
        console.error(`[thumbnail] FFmpeg failed (code ${code}): ${stderr.slice(-500)}`);
        reject(new Error(`FFmpeg thumbnail exit ${code}`));
      }
    });
    ff.on('error', err => {
      console.error(`[thumbnail] FFmpeg spawn error:`, err.message);
      reject(err);
    });
  });

  // Verify frame was created
  if (!fs.existsSync(tmpFrame)) {
    throw new Error(`FFmpeg did not produce frame file: ${tmpFrame}`);
  }
  console.log(`[thumbnail] Frame file size=${fs.statSync(tmpFrame).size} bytes`);

  let image = sharp(tmpFrame);

  const rawBadges = Array.isArray(badges) ? badges : (badges ? [badges] : []);
  // Normalize: accept strings (legacy) or objects with position data
  const badgeList = rawBadges.map(b => {
    if (typeof b === 'string') {
      const cfg = BADGE_CONFIG[b];
      return { key: b, position: cfg?.position === 'right' ? 'top-right' : 'top-left', size: 'medium' };
    }
    return b;
  });
  console.log(`[thumbnail] Badge list to render: ${JSON.stringify(badgeList)}`);

  if (badgeList.length) {
    const THUMB_W = 1280, THUMB_H = 720, PAD = 20;
    const SIZE_MAP = { small: 0.15, medium: 0.22, large: 0.30 };
    // Track vertical offset per corner for stacking (used when no explicit x_pct/y_pct)
    const cornerOffsets = { 'top-left': PAD, 'top-right': PAD, 'bottom-left': PAD, 'bottom-right': PAD };
    const composites = [];

    for (const badge of badgeList) {
      const cfg = BADGE_CONFIG[badge.key];
      if (!cfg) { console.warn(`[thumbnail] Unknown badge: "${badge.key}"`); continue; }

      const badgePath = path.join(BADGE_DIR, cfg.file);
      if (!fs.existsSync(badgePath)) {
        console.warn(`[thumbnail] Badge file missing: ${badgePath}`);
        continue;
      }

      const badgeMeta = await sharp(badgePath).metadata();
      let badgeW, badgeH;

      // Free-position mode: x_pct, y_pct, w_pct are percentages of thumbnail
      if (badge.w_pct != null) {
        badgeW = Math.round(THUMB_W * badge.w_pct / 100);
        badgeH = Math.round(badgeW * (badgeMeta.height / badgeMeta.width));
        const left = Math.round(THUMB_W * badge.x_pct / 100);
        const top = Math.round(THUMB_H * badge.y_pct / 100);
        const resizedBadge = await sharp(badgePath).resize(badgeW, badgeH).png().toBuffer();
        console.log(`[thumbnail] Badge "${badge.key}" free pos: ${badgeW}x${badgeH} at (${left},${top})`);
        composites.push({ input: resizedBadge, top: Math.max(0, Math.min(top, THUMB_H - badgeH)), left: Math.max(0, Math.min(left, THUMB_W - badgeW)) });
      } else {
        // Corner-based mode with stacking
        const sizeRatio = SIZE_MAP[badge.size] || SIZE_MAP.medium;
        badgeW = Math.round(THUMB_W * sizeRatio);
        badgeH = Math.round(badgeW * (badgeMeta.height / badgeMeta.width));
        const resizedBadge = await sharp(badgePath).resize(badgeW, badgeH).png().toBuffer();

        const pos = badge.position || 'top-left';
        const isRight = pos.includes('right');
        const isBottom = pos.includes('bottom');
        const left = isRight ? THUMB_W - badgeW - PAD : PAD;
        const top = isBottom ? THUMB_H - cornerOffsets[pos] - badgeH : cornerOffsets[pos];

        console.log(`[thumbnail] Badge "${badge.key}" at ${pos}, size=${badge.size}, ${badgeW}x${badgeH}, top=${top}, left=${left}`);
        composites.push({ input: resizedBadge, top, left });
        cornerOffsets[pos] += badgeH + 10;
      }
    }
    if (composites.length) {
      image = image.composite(composites);
      console.log(`[thumbnail] Compositing ${composites.length} badge(s)`);
    }
  }

  await image.jpeg({ quality: 90 }).toFile(tmpOut);
  console.log(`[thumbnail] Final thumbnail: ${tmpOut}, size=${fs.statSync(tmpOut).size} bytes`);

  // Clean up frame
  fs.unlink(tmpFrame, () => {});
  return tmpOut;
}

// Upload thumbnail to YouTube broadcast via thumbnails.set API
async function uploadYouTubeThumbnail(userId, accountId, broadcastId, imagePath) {
  console.log(`[thumbnail] Uploading to YouTube: broadcast=${broadcastId}, file=${imagePath}`);

  const account = await getYtAccount(userId, accountId);
  if (!account) throw new Error('No YouTube account found');

  let token = account.access_token;
  const imageBuffer = fs.readFileSync(imagePath);
  console.log(`[thumbnail] Image buffer size=${imageBuffer.length} bytes`);

  const url = `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${broadcastId}&uploadType=media`;

  let resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'image/jpeg',
      'Content-Length': imageBuffer.length,
    },
    body: imageBuffer,
  });

  console.log(`[thumbnail] YouTube API response: ${resp.status} ${resp.statusText}`);

  // Token expired — refresh and retry
  if (resp.status === 401) {
    console.log(`[thumbnail] Token expired, refreshing...`);
    token = await refreshYouTubeToken(account.id);
    if (!token) throw new Error('YouTube token refresh failed');
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'image/jpeg',
        'Content-Length': imageBuffer.length,
      },
      body: imageBuffer,
    });
    console.log(`[thumbnail] Retry response: ${resp.status} ${resp.statusText}`);
  }

  // Clean up thumbnail file
  fs.unlink(imagePath, () => {});

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`[thumbnail] Upload failed: ${resp.status} — ${err}`);
    throw new Error(`Thumbnail upload failed (${resp.status}): ${err}`);
  }

  const result = await resp.json();
  console.log(`[thumbnail] Upload success:`, JSON.stringify(result));
  return result;
}

// POST /youtube/preview-thumbnail — generate preview and return base64 JPEG
app.post('/youtube/preview-thumbnail', async (req, res) => {
  const { video_path, badges } = req.body;
  if (!video_path) return res.status(400).json({ error: 'video_path required' });

  console.log(`[preview-thumbnail] Request: video_path=${video_path}, badges=${JSON.stringify(badges)}, badge_dir=${BADGE_DIR}, badge_dir_exists=${fs.existsSync(BADGE_DIR)}`);

  try {
    const thumbPath = await generateThumbnail(video_path, badges || []);
    const buffer = fs.readFileSync(thumbPath);
    fs.unlink(thumbPath, () => {});
    const base64 = buffer.toString('base64');
    console.log(`[preview-thumbnail] Done, size=${buffer.length} bytes`);
    res.json({ preview: `data:image/jpeg;base64,${base64}` });
  } catch (e) {
    console.error(`[preview-thumbnail] Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// GET /auth/youtube — returns OAuth URL
app.get('/auth/youtube', (req, res) => {
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id required' });

  const params = new URLSearchParams({
    client_id: YT_CLIENT_ID,
    redirect_uri: YT_REDIRECT_URI,
    response_type: 'code',
    scope: YT_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state: userId,
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// GET /auth/youtube/callback — exchange code for tokens
app.get('/auth/youtube/callback', async (req, res) => {
  const { code, state: userId } = req.query;
  if (!code || !userId) return res.status(400).send('Missing code or state');

  try {
    // Exchange code for tokens
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: YT_CLIENT_ID,
        client_secret: YT_CLIENT_SECRET,
        redirect_uri: YT_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenResp.json();
    if (!tokens.access_token) {
      console.error('[youtube] Token exchange failed:', tokens);
      return res.status(400).send('Token exchange failed');
    }

    // Get channel info
    const channelResp = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      { headers: { Authorization: `Bearer ${tokens.access_token}` } }
    );
    const channelData = await channelResp.json();
    const channel = channelData.items?.[0];

    // Save to youtube_accounts table (upsert by channel_id)
    const channelId = channel?.id || null;
    const accountData = {
      user_id: userId,
      channel_id: channelId,
      channel_name: channel?.snippet?.title || null,
      channel_thumb: channel?.snippet?.thumbnails?.default?.url || null,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
    };

    if (channelId) {
      // Check if already exists
      const { data: existing } = await supabaseAdmin
        .from('youtube_accounts')
        .select('id')
        .eq('user_id', userId)
        .eq('channel_id', channelId)
        .single();

      if (existing) {
        await supabaseAdmin.from('youtube_accounts').update(accountData).eq('id', existing.id);
      } else {
        await supabaseAdmin.from('youtube_accounts').insert(accountData);
      }
    }

    console.log(`[youtube] Connected: user=${userId}, channel=${channel?.snippet?.title}`);
    res.redirect('https://castloop.tv/settings.html?youtube=connected');
  } catch (e) {
    console.error('[youtube] Callback error:', e.message);
    res.status(500).send('OAuth failed');
  }
});

// ── Profile ─────────────────────────────────────────────────────────────────

app.get('/api/profile', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(400).json({ error: 'x-user-id required' });

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, plan, phone, whatsapp_notifications')
    .eq('id', userId)
    .single();

  if (error) return res.status(404).json({ error: 'Profile not found' });
  res.json(data);
});

app.patch('/api/profile', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(400).json({ error: 'x-user-id required' });

  const allowed = ['phone', 'whatsapp_notifications'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });

  const { error } = await supabaseAdmin
    .from('profiles')
    .update(updates)
    .eq('id', userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/youtube/accounts', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(400).json({ error: 'x-user-id required' });

  const { data, error } = await supabaseAdmin
    .from('youtube_accounts')
    .select('id, channel_id, channel_name, channel_thumb, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.delete('/youtube/accounts/:id', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(400).json({ error: 'x-user-id required' });

  const { error } = await supabaseAdmin
    .from('youtube_accounts')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Detect YouTube cdn resolution + frameRate from a source video file via ffprobe.
// YouTube requires both fields together: variable+variable, or specific+specific.
async function detectCdnSettings(videoPath) {
  let cdnResolution = 'variable';
  let cdnFrameRate = 'variable';
  if (!videoPath || !fs.existsSync(videoPath)) return { cdnResolution, cdnFrameRate };
  try {
    const [vRes, vMeta] = await Promise.all([
      getVideoResolution(videoPath),
      getVideoMetadata(videoPath),
    ]);
    const w = vRes.width || 0;
    const h = vRes.height || 0;
    const fps = vMeta.fps || 0;
    if (w >= 3840 && h >= 2160) cdnResolution = '2160p';
    else if (w >= 1920 && h >= 1080) cdnResolution = '1080p';
    else if (w >= 1280 && h >= 720) cdnResolution = '720p';
    // Only exact 30 or 60 — anything else (24/25/50) must be variable,
    // otherwise YouTube creates a stream slot that won't match the
    // actual ingestion fps and shows "No data".
    if (fps >= 58 && fps <= 61) cdnFrameRate = '60fps';
    else if (fps >= 29 && fps <= 31) cdnFrameRate = '30fps';
    // Both must be specific or both variable
    if (cdnResolution === 'variable' || cdnFrameRate === 'variable') {
      cdnResolution = 'variable';
      cdnFrameRate = 'variable';
    }
    console.log(`[youtube] Detected ${w}x${h} @ ${fps}fps → cdn resolution=${cdnResolution}, frameRate=${cdnFrameRate}`);
  } catch (e) {
    console.warn(`[youtube] Resolution detection failed for ${videoPath}:`, e.message);
  }
  return { cdnResolution, cdnFrameRate };
}

// POST /youtube/create-broadcast — create live broadcast + stream
app.post('/youtube/create-broadcast', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const { title, description, privacy, account_id, video_path, thumbnail_badges } = req.body;

  if (!userId) return res.status(400).json({ error: 'x-user-id required' });

  try {
    // 1. Create broadcast
    const broadcast = await ytApi(userId,
      'https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status,contentDetails',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snippet: {
            title: title || 'Castloop Live Stream',
            description: description || '',
            scheduledStartTime: new Date().toISOString(),
          },
          status: { privacyStatus: privacy || 'public' },
          contentDetails: {
            enableAutoStart: true,
            enableAutoStop: false,
            latencyPreference: 'ultraLow',
          },
        }),
      },
      account_id
    );

    if (broadcast.error) {
      return res.status(400).json({ error: broadcast.error.message || 'Failed to create broadcast' });
    }

    // 2. Create stream — variable cdn lets YouTube auto-detect from ingestion
    const liveStream = await ytApi(userId,
      'https://www.googleapis.com/youtube/v3/liveStreams?part=snippet,cdn',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snippet: { title: (title || 'Castloop Stream') + ' - ingestion' },
          cdn: {
            ingestionType: 'rtmp',
            resolution: 'variable',
            frameRate: 'variable',
          },
        }),
      },
      account_id
    );

    if (liveStream.error) {
      return res.status(400).json({ error: liveStream.error.message || 'Failed to create stream' });
    }

    // 3. Bind broadcast to stream
    await ytApi(userId,
      `https://www.googleapis.com/youtube/v3/liveBroadcasts/bind?id=${broadcast.id}&part=id,contentDetails&streamId=${liveStream.id}`,
      { method: 'POST' },
      account_id
    );

    const ingestion = liveStream.cdn?.ingestionInfo;
    res.json({
      success: true,
      broadcast_id: broadcast.id,
      stream_id: liveStream.id,
      rtmp_url: ingestion?.ingestionAddress,
      stream_key: ingestion?.streamName,
      watch_url: `https://youtube.com/watch?v=${broadcast.id}`,
    });

    console.log(`[youtube] Broadcast created: ${broadcast.id} for user ${userId}`);
    console.log(`[youtube] Thumbnail params: video_path=${video_path}, thumbnail_badges=${JSON.stringify(thumbnail_badges)}`);

    // 4. Generate and upload thumbnail (non-blocking, after response)
    if (video_path) {
      const badges = Array.isArray(thumbnail_badges) ? thumbnail_badges : [];
      console.log(`[youtube] Starting thumbnail pipeline for broadcast ${broadcast.id}, badges=${JSON.stringify(badges)}`);
      (async () => {
        try {
          const thumbPath = await generateThumbnail(video_path, badges);
          await uploadYouTubeThumbnail(userId, account_id, broadcast.id, thumbPath);
          console.log(`[youtube] Thumbnail pipeline complete for ${broadcast.id}`);
        } catch (err) {
          console.error(`[youtube] Thumbnail pipeline failed for ${broadcast.id}:`, err.message);
        }
      })();
    } else {
      console.warn(`[youtube] No video_path provided, skipping thumbnail generation`);
    }

    // 5. Transition broadcast: testing → live (non-blocking, after response)
    // Wait for FFmpeg to start ingesting before transitioning
    transitionBroadcastToLive(userId, account_id, broadcast.id);
  } catch (e) {
    console.error('[youtube] Create broadcast error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Transition broadcast from upcoming → testing → live
// Polls stream health and waits until ingestion is active before transitioning
async function transitionBroadcastToLive(userId, accountId, broadcastId) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  try {
    // Wait for FFmpeg to start streaming and YouTube to detect ingestion
    // Poll stream status up to 60s
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await sleep(3000);
      try {
        const status = await ytApi(userId,
          `https://www.googleapis.com/youtube/v3/liveBroadcasts?part=status&id=${broadcastId}`,
          { method: 'GET' },
          accountId
        );
        const lifeCycle = status?.items?.[0]?.status?.lifeCycleStatus;
        console.log(`[youtube] Broadcast ${broadcastId} lifeCycleStatus: ${lifeCycle} (poll ${i + 1}/20)`);
        if (lifeCycle === 'live' || lifeCycle === 'liveStarting') {
          console.log(`[youtube] Broadcast ${broadcastId} already live, skip manual transition`);
          return;
        }
        if (lifeCycle === 'ready' || lifeCycle === 'testing' || lifeCycle === 'testStarting') {
          ready = true;
          break;
        }
      } catch (e) {
        console.warn(`[youtube] Status poll failed:`, e.message);
      }
    }

    if (!ready) {
      console.warn(`[youtube] Broadcast ${broadcastId} not ready after polling, attempting transition anyway`);
    }

    // Transition to testing
    try {
      const testRes = await ytApi(userId,
        `https://www.googleapis.com/youtube/v3/liveBroadcasts/transition?broadcastStatus=testing&id=${broadcastId}&part=id,status`,
        { method: 'POST' },
        accountId
      );
      if (testRes?.error) {
        console.warn(`[youtube] testing transition error:`, testRes.error.message);
      } else {
        console.log(`[youtube] Broadcast ${broadcastId} transitioned to testing`);
      }
    } catch (e) {
      console.warn(`[youtube] testing transition exception:`, e.message);
    }

    await sleep(3000);

    // Transition to live
    try {
      const liveRes = await ytApi(userId,
        `https://www.googleapis.com/youtube/v3/liveBroadcasts/transition?broadcastStatus=live&id=${broadcastId}&part=id,status`,
        { method: 'POST' },
        accountId
      );
      if (liveRes?.error) {
        console.error(`[youtube] live transition error:`, liveRes.error.message);
      } else {
        console.log(`[youtube] Broadcast ${broadcastId} transitioned to LIVE`);
      }
    } catch (e) {
      console.error(`[youtube] live transition exception:`, e.message);
    }
  } catch (e) {
    console.error(`[youtube] transitionBroadcastToLive failed for ${broadcastId}:`, e.message);
  }
}

// POST /youtube/end-broadcast — transition broadcast to complete
app.post('/youtube/end-broadcast', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const { broadcast_id } = req.body;

  if (!userId || !broadcast_id) {
    return res.status(400).json({ error: 'user_id and broadcast_id required' });
  }

  try {
    const result = await ytApi(userId,
      `https://www.googleapis.com/youtube/v3/liveBroadcasts/transition?broadcastStatus=complete&id=${broadcast_id}&part=id,status`,
      { method: 'POST' }
    );

    if (result.error) {
      return res.status(400).json({ error: result.error.message });
    }

    console.log(`[youtube] Broadcast ended: ${broadcast_id}`);
    res.json({ success: true, broadcast_id });
  } catch (e) {
    console.error('[youtube] End broadcast error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /youtube/restart-broadcast — end current, create new, return new keys
app.post('/youtube/restart-broadcast', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const { broadcast_id, title, description, privacy, video_path } = req.body;

  if (!userId) return res.status(400).json({ error: 'x-user-id required' });

  const { cdnResolution, cdnFrameRate } = await detectCdnSettings(video_path);

  try {
    // End current broadcast if provided
    if (broadcast_id) {
      try {
        await ytApi(userId,
          `https://www.googleapis.com/youtube/v3/liveBroadcasts/transition?broadcastStatus=complete&id=${broadcast_id}&part=id,status`,
          { method: 'POST' }
        );
        console.log(`[youtube] Ended broadcast ${broadcast_id} for restart`);
      } catch (e) {
        console.warn(`[youtube] Could not end broadcast ${broadcast_id}:`, e.message);
      }
    }

    // Create new broadcast
    const broadcast = await ytApi(userId,
      'https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status,contentDetails',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snippet: {
            title: title || 'Castloop Live Stream',
            description: description || 'Powered by Castloop',
            scheduledStartTime: new Date().toISOString(),
          },
          status: { privacyStatus: privacy || 'public' },
          contentDetails: { enableAutoStart: true, enableAutoStop: false, latencyPreference: 'ultraLow' },
        }),
      }
    );

    const liveStream = await ytApi(userId,
      'https://www.googleapis.com/youtube/v3/liveStreams?part=snippet,cdn',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snippet: { title: (title || 'Castloop Stream') + ' - ingestion' },
          cdn: { frameRate: cdnFrameRate, ingestionType: 'rtmp', resolution: cdnResolution },
        }),
      }
    );

    await ytApi(userId,
      `https://www.googleapis.com/youtube/v3/liveBroadcasts/bind?id=${broadcast.id}&part=id,contentDetails&streamId=${liveStream.id}`,
      { method: 'POST' }
    );

    const ingestion = liveStream.cdn?.ingestionInfo;
    res.json({
      success: true,
      broadcast_id: broadcast.id,
      stream_id: liveStream.id,
      rtmp_url: ingestion?.ingestionAddress,
      stream_key: ingestion?.streamName,
    });

    // Transition new broadcast to live (non-blocking)
    transitionBroadcastToLive(userId, null, broadcast.id);
  } catch (e) {
    console.error('[youtube] Restart broadcast error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Stream restart timer ────────────────────────────────────────────────────

const restartTimers = {};

app.post('/set-restart-timer', async (req, res) => {
  const { streamId, hours, userId, broadcastId, title } = req.body;
  if (!streamId || !hours) return res.status(400).json({ error: 'streamId and hours required' });

  // Clear existing timer
  if (restartTimers[streamId]) {
    clearTimeout(restartTimers[streamId]);
    delete restartTimers[streamId];
  }

  const ms = hours * 3600 * 1000;
  const restartAt = new Date(Date.now() + ms).toISOString();
  console.log(`[restart] Timer set: ${streamId} will restart at ${restartAt}`);

  // Persist to Supabase
  await supabaseAdmin.from('streams').update({ restart_at: restartAt }).eq('id', streamId);

  restartTimers[streamId] = setTimeout(async () => {
    delete restartTimers[streamId];
    console.log(`[restart] Executing restart for ${streamId}`);

    // Clear restart_at in DB
    await supabaseAdmin.from('streams').update({ restart_at: null }).eq('id', streamId);

    try {
      // 1. Stop current FFmpeg
      if (activeStreams[streamId]) {
        activeStreams[streamId].kill('SIGTERM');
        delete activeStreams[streamId];
      }

      // 2. If YouTube broadcast, end old + create new
      if (userId && broadcastId) {
        // Fetch first video path for cdn auto-detection
        let firstVideoPath = null;
        try {
          const { data: streamRow } = await supabaseAdmin
            .from('streams').select('video_paths').eq('id', streamId).single();
          let paths = streamRow?.video_paths;
          if (typeof paths === 'string') { try { paths = JSON.parse(paths); } catch { paths = []; } }
          if (Array.isArray(paths) && paths.length) {
            firstVideoPath = typeof paths[0] === 'object' ? paths[0].path : paths[0];
          }
        } catch (e) { console.warn('[restart] Could not fetch video_paths:', e.message); }

        const resp = await fetch(`http://localhost:3000/youtube/restart-broadcast`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'x-user-id': userId,
          },
          body: JSON.stringify({ broadcast_id: broadcastId, title, video_path: firstVideoPath }),
        });
        const newBroadcast = await resp.json();

        if (newBroadcast.success && newBroadcast.rtmp_url && newBroadcast.stream_key) {
          // Update stream with new keys
          await supabaseAdmin.from('streams').update({
            rtmp_url: newBroadcast.rtmp_url,
            stream_key: newBroadcast.stream_key,
          }).eq('id', streamId);

          // 3. Restart FFmpeg with new keys
          const { data: stream } = await supabaseAdmin
            .from('streams')
            .select('*')
            .eq('id', streamId)
            .single();

          if (stream) {
            const videoPaths = Array.isArray(stream.video_paths) ? stream.video_paths : [];
            const paths = videoPaths.map(v => typeof v === 'object' ? v.path : v).filter(Boolean);
            if (paths.length) {
              // Re-trigger start via local API
              await fetch('http://localhost:3000/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
                body: JSON.stringify({
                  streamId,
                  rtmpUrl: newBroadcast.rtmp_url,
                  streamKey: newBroadcast.stream_key,
                  videoPaths: paths,
                }),
              });
            }
          }
          console.log(`[restart] ${streamId}: Restarted with new broadcast ${newBroadcast.broadcast_id}`);
        }
      } else {
        // Non-YouTube: just restart FFmpeg with same keys
        const { data: stream } = await supabaseAdmin
          .from('streams')
          .select('*')
          .eq('id', streamId)
          .single();

        if (stream) {
          const videoPaths = Array.isArray(stream.video_paths) ? stream.video_paths : [];
          const paths = videoPaths.map(v => typeof v === 'object' ? v.path : v).filter(Boolean);
          if (paths.length) {
            streamStopped[streamId] = false;
            delete streamFailCount[streamId];
            await fetch('http://localhost:3000/start', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
              body: JSON.stringify({
                streamId,
                rtmpUrl: stream.rtmp_url,
                streamKey: stream.stream_key,
                videoPaths: paths,
              }),
            });
          }
        }
        console.log(`[restart] ${streamId}: Restarted with same keys`);
      }
    } catch (e) {
      console.error(`[restart] Error restarting ${streamId}:`, e.message);
    }
  }, ms);

  res.json({ success: true, restart_at: new Date(Date.now() + ms).toISOString() });
});

app.post('/cancel-restart-timer', async (req, res) => {
  const { streamId } = req.body;
  if (restartTimers[streamId]) {
    clearTimeout(restartTimers[streamId]);
    delete restartTimers[streamId];
    console.log(`[restart] Timer cancelled for ${streamId}`);
  }
  await supabaseAdmin.from('streams').update({ restart_at: null }).eq('id', streamId);
  res.json({ success: true });
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

// Clean up interrupted normalize jobs from previous run
function cleanupStaleNormalize() {
  const videosRoot = '/var/castloop/videos';
  if (!fs.existsSync(videosRoot)) return;
  let cleaned = 0;
  for (const userId of fs.readdirSync(videosRoot)) {
    const dir = path.join(videosRoot, userId);
    if (!fs.statSync(dir).isDirectory()) continue;

    // Delete orphaned .normalizing.mp4 temp files
    for (const f of fs.readdirSync(dir)) {
      if (f.includes('.normalizing.')) {
        fs.unlinkSync(path.join(dir, f));
        console.log(`[normalize-cleanup] Deleted orphaned temp file: ${userId}/${f}`);
        cleaned++;
      }
    }

    // Clear stale normalizing flags in _meta.json
    const metaFile = path.join(dir, '_meta.json');
    if (!fs.existsSync(metaFile)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      let changed = false;
      for (const [filename, entry] of Object.entries(meta)) {
        if (entry && entry.normalizing) {
          delete entry.normalizing;
          changed = true;
          console.log(`[normalize-cleanup] Cleared stale normalizing flag: ${userId}/${filename}`);
        }
      }
      if (changed) fs.writeFileSync(metaFile, JSON.stringify(meta));
    } catch {}
  }
  if (cleaned) console.log(`[normalize-cleanup] Cleaned ${cleaned} orphaned temp files`);
  else console.log('[normalize-cleanup] No stale normalize artifacts found');
}

app.listen(3000, () => {
  console.log('Castloop Stream API running on port 3000');
  cleanupStaleNormalize();
  recoverRunningStreamsOnStartup();

  // Start reconciler after 30s, then every 2 min
  setTimeout(() => {
    reconcile();
    setInterval(reconcile, 2 * 60 * 1000);
  }, 30000);
});
