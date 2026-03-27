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

function getDateInTz(date, tz) {
  const parts = date.toLocaleDateString('en-CA', { timeZone: tz }).split('-');
  return parts.join('-'); // YYYY-MM-DD
}

function getPrevDateInTz(date, tz) {
  const d = new Date(date.toLocaleString('en-US', { timeZone: tz }));
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function isInWindow(currentTime, startTime, endTime) {
  if (endTime > startTime) {
    return currentTime >= startTime && currentTime < endTime;
  } else {
    // Wraps midnight: e.g. 22:00-02:00
    return currentTime >= startTime || currentTime < endTime;
  }
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

function isScheduleActiveNow(sched, now) {
  const tz = sched.timezone || 'UTC';
  const currentTime = getTimeInTz(now, tz);
  const startTime = sched.start_time || '00:00:00';
  const endTime = sched.end_time || '23:59:59';
  const wrapsMidnight = endTime <= startTime;

  // Date-based schedule (schedule_date field)
  if (sched.schedule_date) {
    const todayDate = getDateInTz(now, tz);
    const prevDate = getPrevDateInTz(now, tz);

    if (sched.schedule_date === todayDate) {
      // Today's schedule — check if we're in the time window
      return isInWindow(currentTime, startTime, endTime);
    }

    if (wrapsMidnight && sched.schedule_date === prevDate) {
      // Yesterday's schedule wraps past midnight into today
      // We're in window if currentTime < endTime
      return currentTime < endTime;
    }

    return false;
  }

  // Legacy day-based schedule (days[] field) — backwards compatible
  if (sched.days && sched.days.length > 0) {
    const todayDay = getDayName(now, tz);

    if (sched.days.includes(todayDay)) {
      return isInWindow(currentTime, startTime, endTime);
    }

    // If schedule wraps midnight, check if yesterday was a scheduled day
    if (wrapsMidnight) {
      const yesterday = new Date(now.getTime() - 86400000);
      const yesterdayDay = getDayName(yesterday, tz);
      if (sched.days.includes(yesterdayDay)) {
        return currentTime < endTime;
      }
    }

    return false;
  }

  return false;
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
    const shouldBeRunning = streamScheds.some(sched => isScheduleActiveNow(sched, now));

    if (shouldBeRunning && stream.status !== 'running') {
      const videoPaths = parseVideoPaths(stream.video_paths);
      if (!videoPaths.length) { console.log(`[scheduler] ${stream.id}: No video paths, skipping.`); continue; }

      console.log(`[scheduler] ${stream.id}: Starting (schedule window active)`);
      try {
        const apiUrl = stream.server_id ? await getServerApiUrl(stream.server_id) : DEFAULT_API_URL;
        const result = await apiCall(apiUrl, '/start', {
          streamId: stream.id,
          rtmpUrl: stream.rtmp_url,
          streamKey: stream.stream_key,
          videoPaths
        });
        if (result.error === 'Stream already running') {
          console.log(`[scheduler] ${stream.id}: Already running on API, updating DB status.`);
        }
        await sbUpdate('streams', `id=eq.${stream.id}`, { status: 'running' });
      } catch (e) { console.error(`[scheduler] Start error ${stream.id}:`, e.message); }

    } else if (!shouldBeRunning && stream.status === 'running') {
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
