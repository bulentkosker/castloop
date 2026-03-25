const SUPABASE_URL = 'https://pdttjblnvxoitskhdtro.supabase.co';
const HETZNER_API_URL = 'https://api.hetzner.cloud/v1';
const LOAD_THRESHOLD = 0.8;
const DEFAULT_SERVER_TYPE = '1080p';
const DEFAULT_MAX_STREAMS = 20;
const DEFAULT_LOCATION = 'hel1';
const DEFAULT_HETZNER_TYPE = 'ccx23';
const DEFAULT_IMAGE = 'ubuntu-24.04';
const DEFAULT_NFS_SERVER = '89.167.122.245';
const DEFAULT_NFS_EXPORT = '/var/castloop/videos';

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload, null, 2));
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildSupabaseUrl(table, query) {
  const suffix = query ? `?${query}` : '';
  return `${SUPABASE_URL}/rest/v1/${table}${suffix}`;
}

async function supabaseRequest(table, { method = 'GET', query = '', body, headers = {} } = {}) {
  const supabaseKey = process.env.SUPABASE_KEY;
  const response = await fetch(buildSupabaseUrl(table, query), {
    method,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });

  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message = data && data.message ? data.message : response.statusText;
    const error = new Error(`Supabase request failed: ${message}`);
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

async function hetznerRequest(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${HETZNER_API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.HETZNER_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data && data.error && data.error.message ? data.error.message : response.statusText;
    const error = new Error(`Hetzner request failed: ${message}`);
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

function summarizeServer(server) {
  const active = toNumber(server.active_streams);
  const max = Math.max(1, toNumber(server.max_streams, 1));
  const ratio = active / max;
  return {
    id: server.id,
    name: server.name,
    status: server.status,
    active_streams: active,
    max_streams: max,
    ratio,
    server_type: server.server_type || null,
    api_url: server.api_url || null,
    ip: server.ip || null
  };
}

function shellDoubleQuoted(value) {
  return JSON.stringify(value == null ? '' : String(value));
}

function indent(text, size) {
  const prefix = ' '.repeat(size);
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function buildCloudInit(config) {
  const bootstrapScript = [
    '#!/usr/bin/env bash',
    'set -euxo pipefail',
    'export DEBIAN_FRONTEND=noninteractive',
    `REPO_URL=${shellDoubleQuoted(config.castloopApiRepoUrl)}`,
    `ARCHIVE_URL=${shellDoubleQuoted(config.castloopApiArchiveUrl)}`,
    `REPO_BRANCH=${shellDoubleQuoted(config.castloopApiRepoBranch)}`,
    `NFS_SERVER=${shellDoubleQuoted(config.nfsServer)}`,
    `NFS_EXPORT=${shellDoubleQuoted(config.nfsExport)}`,
    `APP_DIR=${shellDoubleQuoted('/root/castloop')}`,
    '',
    'apt-get update',
    'apt-get install -y ca-certificates curl gnupg git ffmpeg nfs-common',
    'if ! command -v node >/dev/null 2>&1; then',
    '  install -m 0755 -d /etc/apt/keyrings',
    '  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg',
    '  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list',
    '  apt-get update',
    '  apt-get install -y nodejs',
    'fi',
    'npm install -g pm2',
    'mkdir -p /var/castloop/videos',
    'FSTAB_LINE="$NFS_SERVER:$NFS_EXPORT /var/castloop/videos nfs defaults,_netdev 0 0"',
    'grep -qF "$FSTAB_LINE" /etc/fstab || echo "$FSTAB_LINE" >> /etc/fstab',
    'mount -a || true',
    'rm -rf "$APP_DIR"',
    'mkdir -p "$APP_DIR"',
    'if [ -n "$REPO_URL" ]; then',
    '  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"',
    'elif [ -n "$ARCHIVE_URL" ]; then',
    '  curl -fsSL "$ARCHIVE_URL" -o /tmp/castloop.tar.gz',
    '  tar -xzf /tmp/castloop.tar.gz -C "$APP_DIR" --strip-components=1',
    'else',
    '  echo "CASTLOOP_API_REPO_URL or CASTLOOP_API_ARCHIVE_URL must be set for autoscaling." >&2',
    '  exit 1',
    'fi',
    'cd "$APP_DIR"',
    'if [ -f package-lock.json ]; then',
    '  npm ci --omit=dev',
    'elif [ -f package.json ]; then',
    '  npm install --omit=dev',
    'else',
    '  npm init -y',
    '  npm install express cors multer @supabase/supabase-js',
    'fi',
    'pm2 delete castloop-api || true',
    'pm2 start index.js --name castloop-api',
    'pm2 save',
    '',
    '# Firewall rules',
    'ufw deny proto tcp from any to any port 111',
    'ufw deny proto udp from any to any port 111',
    'ufw allow 22',
    'ufw allow 3000',
    'ufw --force enable'
  ].join('\n');

  return [
    '#cloud-config',
    'package_update: true',
    'package_upgrade: false',
    'write_files:',
    '  - path: /root/bootstrap-castloop.sh',
    "    permissions: '0755'",
    '    content: |',
    indent(bootstrapScript, 6),
    'runcmd:',
    '  - [ bash, -lc, "/root/bootstrap-castloop.sh > /var/log/castloop-bootstrap.log 2>&1" ]'
  ].join('\n');
}

function buildInsertPayload(serverName, serverIp, config) {
  return {
    name: serverName,
    ip: serverIp,
    api_url: `http://${serverIp}:3000`,
    status: 'provisioning',
    active_streams: 0,
    max_streams: config.maxStreamsPerServer,
    server_type: config.serverType
  };
}

function getConfig() {
  return {
    maxStreamsPerServer: Math.max(1, toNumber(process.env.AUTOSCALE_MAX_STREAMS, DEFAULT_MAX_STREAMS)),
    serverType: process.env.AUTOSCALE_SERVER_TYPE || DEFAULT_SERVER_TYPE,
    hetznerType: process.env.HETZNER_SERVER_TYPE || DEFAULT_HETZNER_TYPE,
    hetznerLocation: process.env.HETZNER_LOCATION || DEFAULT_LOCATION,
    hetznerImage: process.env.HETZNER_IMAGE || DEFAULT_IMAGE,
    nfsServer: process.env.NFS_SERVER || DEFAULT_NFS_SERVER,
    nfsExport: process.env.NFS_EXPORT || DEFAULT_NFS_EXPORT,
    castloopApiRepoUrl: process.env.CASTLOOP_API_REPO_URL || '',
    castloopApiRepoBranch: process.env.CASTLOOP_API_REPO_BRANCH || 'main',
    castloopApiArchiveUrl: process.env.CASTLOOP_API_ARCHIVE_URL || '',
    autoscaleToken: process.env.AUTOSCALE_TOKEN || ''
  };
}

function validateConfig(config) {
  const missing = [];
  if (!process.env.HETZNER_API_TOKEN) missing.push('HETZNER_API_TOKEN');
  if (!process.env.SUPABASE_KEY) missing.push('SUPABASE_KEY');
  if (!config.castloopApiRepoUrl && !config.castloopApiArchiveUrl) {
    missing.push('CASTLOOP_API_REPO_URL or CASTLOOP_API_ARCHIVE_URL');
  }
  return missing;
}

function authorize(req, config) {
  if (!config.autoscaleToken) return true;
  const headerToken = req.headers['x-autoscale-token'];
  return headerToken && headerToken === config.autoscaleToken;
}

function buildServerName() {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `castloop-${timestamp}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { error: 'Method not allowed' });
  }

  const config = getConfig();
  if (!authorize(req, config)) {
    return json(res, 401, { error: 'Unauthorized autoscale request' });
  }

  const missing = validateConfig(config);
  if (missing.length) {
    return json(res, 500, {
      error: 'Autoscale is not fully configured',
      missing
    });
  }

  try {
    const serverRows = await supabaseRequest('servers', {
      query: 'select=id,name,ip,api_url,status,active_streams,max_streams,server_type&order=name.asc'
    });

    const servers = Array.isArray(serverRows) ? serverRows.map(summarizeServer) : [];
    const overloaded = servers.filter((server) => server.status === 'active' && server.ratio > LOAD_THRESHOLD);
    const provisioning = servers.filter((server) => ['provisioning', 'installing', 'bootstrapping'].includes(server.status));

    if (!overloaded.length) {
      return json(res, 200, {
        ok: true,
        action: 'none',
        reason: 'capacity-healthy',
        threshold: LOAD_THRESHOLD,
        servers
      });
    }

    if (provisioning.length) {
      return json(res, 200, {
        ok: true,
        action: 'none',
        reason: 'provisioning-server-exists',
        threshold: LOAD_THRESHOLD,
        overloaded,
        provisioning
      });
    }

    const serverName = buildServerName();
    const cloudInit = buildCloudInit(config);
    const hetznerPayload = {
      name: serverName,
      server_type: config.hetznerType,
      image: config.hetznerImage,
      location: config.hetznerLocation,
      start_after_create: true,
      ssh_keys: ['castloop'],
      public_net: {
        enable_ipv4: true,
        enable_ipv6: false
      },
      labels: {
        app: 'castloop',
        managed_by: 'vercel-autoscale',
        role: 'stream-api'
      },
      user_data: cloudInit
    };

    const hetzner = await hetznerRequest('/servers', {
      method: 'POST',
      body: hetznerPayload
    });

    const serverIp = hetzner && hetzner.server && hetzner.server.public_net && hetzner.server.public_net.ipv4
      ? hetzner.server.public_net.ipv4.ip
      : null;

    if (!serverIp) {
      return json(res, 502, {
        error: 'Hetzner server was created but no public IPv4 was returned',
        hetzner
      });
    }

    const insertPayload = buildInsertPayload(serverName, serverIp, config);
    const insertedRows = await supabaseRequest('servers', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: insertPayload
    });

    return json(res, 201, {
      ok: true,
      action: 'created',
      threshold: LOAD_THRESHOLD,
      overloaded,
      created: {
        hetzner_server_id: hetzner.server.id,
        ip: serverIp,
        name: serverName,
        location: config.hetznerLocation,
        server_type: config.hetznerType,
        image: config.hetznerImage,
        supabase: Array.isArray(insertedRows) ? insertedRows[0] || null : insertedRows
      }
    });
  } catch (error) {
    return json(res, error.status || 500, {
      error: error.message || 'Autoscale failed',
      details: error.details || null
    });
  }
};