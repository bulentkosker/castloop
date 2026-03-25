require('dotenv').config({ path: '/root/.env' });
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://pdttjblnvxoitskhdtro.supabase.co';
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

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

  const { data: schedules, error } = await supabase
    .from('stream_schedules')
    .select('*, streams:stream_id(id, rtmp_url, stream_key, video_paths, status, server_id)')
    .eq('enabled', true);

  if (error) { console.error('[scheduler] Query error:', error.message); return; }
  if (!schedules || !schedules.length) return;

  for (const sched of schedules) {
    const stream = sched.streams;
    if (!stream) continue;

    const tz = sched.timezone || 'UTC';
    const day = getDayName(now, tz);
    const currentTime = getTimeInTz(now, tz);

    if (!sched.days || !sched.days.includes(day)) {
      // Not a scheduled day — if stream is running and was started by scheduler, stop it
      if (stream.status === 'running') {
        console.log(`[scheduler] ${stream.id}: Not a scheduled day (${day}), stopping.`);
        try {
          const apiUrl = stream.server_id ? await getServerApiUrl(stream.server_id) : DEFAULT_API_URL;
          await apiCall(apiUrl, '/stop', { streamId: stream.id });
          await supabase.from('streams').update({ status: 'stopped' }).eq('id', stream.id);
        } catch (e) { console.error(`[scheduler] Stop error ${stream.id}:`, e.message); }
      }
      continue;
    }

    const startTime = sched.start_time || '00:00:00';
    const endTime = sched.end_time || '23:59:59';
    const inWindow = currentTime >= startTime && currentTime < endTime;

    if (inWindow && stream.status !== 'running') {
      // Should be running but isn't — start it
      const videoPaths = parseVideoPaths(stream.video_paths);
      if (!videoPaths.length) { console.log(`[scheduler] ${stream.id}: No video paths, skipping.`); continue; }

      console.log(`[scheduler] ${stream.id}: Starting (${currentTime} in ${startTime}-${endTime}, ${tz})`);
      try {
        const apiUrl = stream.server_id ? await getServerApiUrl(stream.server_id) : DEFAULT_API_URL;
        await apiCall(apiUrl, '/start', {
          streamId: stream.id,
          rtmpUrl: stream.rtmp_url,
          streamKey: stream.stream_key,
          videoPaths
        });
        await supabase.from('streams').update({ status: 'running' }).eq('id', stream.id);
      } catch (e) { console.error(`[scheduler] Start error ${stream.id}:`, e.message); }

    } else if (!inWindow && stream.status === 'running') {
      // Outside window but running — stop it
      console.log(`[scheduler] ${stream.id}: Stopping (${currentTime} outside ${startTime}-${endTime}, ${tz})`);
      try {
        const apiUrl = stream.server_id ? await getServerApiUrl(stream.server_id) : DEFAULT_API_URL;
        await apiCall(apiUrl, '/stop', { streamId: stream.id });
        await supabase.from('streams').update({ status: 'stopped' }).eq('id', stream.id);
      } catch (e) { console.error(`[scheduler] Stop error ${stream.id}:`, e.message); }
    }
  }
}

async function getServerApiUrl(serverId) {
  const { data } = await supabase
    .from('servers')
    .select('api_url')
    .eq('id', serverId)
    .single();
  return data?.api_url || DEFAULT_API_URL;
}

// Run every 60 seconds
console.log('[scheduler] Started. Checking every 60s.');
tick();
setInterval(tick, 60 * 1000);
