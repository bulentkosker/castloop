require('dotenv').config({ path: '/root/.env' });

const SUPABASE_URL = 'https://pdttjblnvxoitskhdtro.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SB_HEADERS = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };

const API_KEY = 'castloop-secret-2024';
const DEFAULT_API_URL = 'http://localhost:3000';

function getDayName(date, tz) {
  return date.toLocaleDateString('en-US', { weekday: 'short', timeZone: tz }).toLowerCase();
}

function getTimeInTz(date, tz) {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: tz });
}

function parseVideoPaths(raw) {
  const extract = (item) => (typeof item === 'object' && item !== null ? item.path : item);
  if (Array.isArray(raw)) return raw.map(extract).filter(Boolean);
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(extract).filter(Boolean) : [raw];
    } catch { return [raw]; }
  }
  return [];
}

async function sbGet(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: SB_HEADERS });
  return res.json();
}

async function sbUpdate(table, query, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: { ...SB_HEADERS, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(body)
  });
  return res.ok;
}

async function apiCall(url, endpoint, body) {
  const resp = await fetch(`${url}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(body)
  });
  return resp.json();
}

async function tick() {
  const now = new Date();

  let schedules;
  try {
    schedules = await sbGet('stream_schedules', 'enabled=eq.true&select=*');
  } catch (e) { console.error('[scheduler] Schedules fetch error:', e.message); return; }

  if (!Array.isArray(schedules) || !schedules.length) return;

  // Group schedules by stream_id
  const schedulesByStream = {};
  for (const sched of schedules) {
    if (!sched.stream_id) continue;
    if (!schedulesByStream[sched.stream_id]) schedulesByStream[sched.stream_id] = [];
    schedulesByStream[sched.stream_id].push(sched);
  }

  const streamIds = Object.keys(schedulesByStream);
  if (!streamIds.length) return;

  let streams;
  try {
    streams = await sbGet('streams', `id=in.(${streamIds.join(',')})&select=id,rtmp_url,stream_key,video_paths,status,server_id`);
  } catch (e) { console.error('[scheduler] Streams fetch error:', e.message); return; }

  const streamMap = {};
  if (Array.isArray(streams)) streams.forEach(s => { streamMap[s.id] = s; });

  for (const streamId of streamIds) {
    const stream = streamMap[streamId];
    if (!stream) continue;

    const streamScheds = schedulesByStream[streamId];

    // Check if ANY schedule is currently active for this stream
    let anyActive = false;
    for (const sched of streamScheds) {
      const tz = sched.timezone || 'UTC';
      const day = getDayName(now, tz);
      const currentTime = getTimeInTz(now, tz);

      if (!sched.days || !sched.days.includes(day)) continue;

      const startTime = sched.start_time || '00:00:00';
      const endTime = sched.end_time || '23:59:59';

      if (currentTime >= startTime && currentTime < endTime) {
        anyActive = true;
        break;
      }
    }

    if (anyActive && stream.status !== 'running') {
      const videoPaths = parseVideoPaths(stream.video_paths);
      if (!videoPaths.length) { console.log(`[scheduler] ${stream.id}: No video paths, skipping.`); continue; }

      console.log(`[scheduler] ${stream.id}: Starting (schedule window active)`);
      try {
        const apiUrl = stream.server_id ? await getServerApiUrl(stream.server_id) : DEFAULT_API_URL;
        await apiCall(apiUrl, '/start', {
          streamId: stream.id,
          rtmpUrl: stream.rtmp_url,
          streamKey: stream.stream_key,
          videoPaths
        });
        await sbUpdate('streams', `id=eq.${stream.id}`, { status: 'running' });
      } catch (e) { console.error(`[scheduler] Start error ${stream.id}:`, e.message); }

    } else if (!anyActive && stream.status === 'running') {
      console.log(`[scheduler] ${stream.id}: Stopping (no schedule window active)`);
      try {
        const apiUrl = stream.server_id ? await getServerApiUrl(stream.server_id) : DEFAULT_API_URL;
        await apiCall(apiUrl, '/stop', { streamId: stream.id });
        await sbUpdate('streams', `id=eq.${stream.id}`, { status: 'stopped' });
      } catch (e) { console.error(`[scheduler] Stop error ${stream.id}:`, e.message); }
    }
  }
}

async function getServerApiUrl(serverId) {
  const rows = await sbGet('servers', `id=eq.${serverId}&select=api_url&limit=1`);
  return (Array.isArray(rows) && rows[0]?.api_url) || DEFAULT_API_URL;
}

// Run every 60 seconds
console.log('[scheduler] Started. Checking every 60s.');
tick();
setInterval(tick, 60 * 1000);
