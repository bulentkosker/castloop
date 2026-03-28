# Castloop — Project Guide

## Architecture

Three servers run the same `index.js` (FFmpeg streaming API):

| Server | Hostname | Type | ENV `SERVER_TYPE` |
|--------|----------|------|-------------------|
| server-1 | api.castloop.tv | HD (1080p) | _(unset or `1080p`)_ |
| server-4k | api4k.castloop.tv | 4K passthrough | `4k` |
| castloop-auto | Auto-provisioned via Hetzner | HD (1080p) | `1080p` |

- **scheduler.js** runs on the main server (89.167.122.245), checks schedules every 60s
- **Frontend** (dashboard.html, login.html, etc.) is deployed on Vercel
- **Autoscale** (`api/autoscale.js`) is a Vercel serverless function

## Important Rules

### Supabase Keys
- **NEVER** hardcode Supabase keys in source code
- Always use `process.env.SUPABASE_SERVICE_KEY`
- Both `supabase` and `supabaseAdmin` clients use the same service key

### Deployment
When `index.js` is modified, deploy to all 3 servers:
```bash
# On each server:
cd /root/castloop
curl -sL https://raw.githubusercontent.com/bulentkosker/castloop/main/index.js -o index.js
pm2 restart castloop-api
```

### Environment
`.env` is at `/root/.env` on each server. Required variables:
```
SUPABASE_SERVICE_KEY=...
SERVER_TYPE=4k          # only on 4K server, omit for HD
SERVER_ID=...           # optional, auto-detected from IP if missing
YOUTUBE_CLIENT_ID=...   # Google OAuth client ID
YOUTUBE_CLIENT_SECRET=... # Google OAuth client secret
LEMONSQUEEZY_WEBHOOK_SECRET=... # LemonSqueezy webhook HMAC secret
TWILIO_ACCOUNT_SID=...          # Twilio account SID
TWILIO_AUTH_TOKEN=...           # Twilio auth token
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886  # Twilio WhatsApp sender
```

## Database Schema

### `streams` table columns
`id`, `rtmp_url`, `stream_key`, `video_paths`, `status`, `server_id`, `name`, `platform`, `created_at`, `user_id`, `restart_at`, `youtube_account_id`, `youtube_broadcast_id`, `youtube_stream_id`

**Columns that DO NOT exist:** `max_duration`, `stream_id`

### `stream_schedules` table columns
`id`, `stream_id`, `user_id`, `enabled`, `start_time`, `end_time`, `schedule_date`, `days`, `timezone`

- `schedule_date` (DATE, YYYY-MM-DD) — new date-based scheduling
- `days` (array) — legacy day-of-week scheduling, kept for backwards compat

### `servers` table columns
`id`, `name`, `ip`, `api_url`, `status`, `active_streams`, `max_streams`, `server_type`

### `profiles` table columns
`id`, `plan`, `trial_started_at`, `phone`, `whatsapp_notifications`

### `youtube_accounts` table columns
`id`, `user_id`, `channel_id`, `channel_name`, `channel_thumb`, `access_token`, `refresh_token`, `created_at`

- Supports multiple YouTube channels per user
- UNIQUE constraint on (user_id, channel_id)

## Key Components

### index.js (Stream API)
- `/start` — Start FFmpeg stream
- `/stop` — Stop stream and clean up
- `/delete` — Kill FFmpeg + full state cleanup
- `/status/:streamId` — Check if FFmpeg is running
- `/videos` — List user's uploaded videos
- **Startup recovery** — On boot, restarts streams that were `running` in DB
- **Reconciler** — Every 2 min, syncs activeStreams with Supabase (kills orphans, marks stale as stopped)
- **4K mode** — When `SERVER_TYPE=4k`, uses `-c:v copy -c:a copy` (no re-encode)
- **YouTube OAuth** — `/auth/youtube`, `/auth/youtube/callback`, `/youtube/status`
- **YouTube Broadcast** — `/youtube/create-broadcast`, `/youtube/end-broadcast`, `/youtube/restart-broadcast`
- **Stream restart timer** — `/set-restart-timer`, `/cancel-restart-timer` (auto-restart after X hours)
- **WhatsApp alerts** — Sends Twilio WhatsApp message when stream fails 3 times

### scheduler.js
- Runs every 60s, fetches enabled schedules
- Groups by `stream_id`, checks if ANY schedule is active
- Supports both `schedule_date` and legacy `days[]`
- Handles midnight-wrapping time windows (e.g. 22:00-06:00)

### dashboard.html
- Schedule modal uses date picker + duration (hours/minutes) instead of end time
- Stop always updates Supabase even if API call fails (reconciler cleans up later)
- Multi-schedule per stream supported
