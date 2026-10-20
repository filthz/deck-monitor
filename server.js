#!/usr/bin/env node
// Taskmonitor deck server: receives Claude Code / Qwen Code hook events, polls Orca,
// streams session status to browsers via Server-Sent Events and relays actions
// (acknowledge, focus, screen preview, send input) to Orca.
// Only reachable from the networks in TASKMONITOR_ALLOW (default: loopback + 192.168.0.0/16).
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createOrcaAdapter } = require('./orca');

const PORT = Number(process.env.TASKMONITOR_PORT || 7777);
const ALLOW_SPEC = process.env.TASKMONITOR_ALLOW || '127.0.0.0/8,192.168.0.0/16';
const ALLOW = ALLOW_SPEC.split(',').map(parseCidr);
const DIR = __dirname;
const PUBLIC_DIR = path.join(DIR, 'public');
const STATE_FILE = path.join(DIR, 'state.json');
const TOKEN_FILE = path.join(DIR, '.token');
const ACKS_FILE = path.join(DIR, 'acks.json');

const ENDED_TTL_MS = 10 * 60 * 1000;
const LIVENESS_INTERVAL_MS = 10 * 1000;

// Tools that block on the user even though no permission dialog is involved.
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'ask_user_question', 'exit_plan_mode']);
// Tools that leave work running after the turn ends.
const WAKEUP_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate']);

const token = loadToken();
const sessions = loadState();
const clients = new Set();
const acks = loadAcks(); // Orca session id -> acknowledged stateStartedAt

const orca = createOrcaAdapter({
  upsert(next) {
    // Drop hook-tracked duplicates of the same Orca pane.
    for (const s of sessions.values()) {
      if (s.via !== 'orca' && s.term && s.term.orcaPane === next.orcaPane) {
        sessions.delete(s.id);
        broadcast({ type: 'remove', id: s.id });
      }
    }
    const prev = sessions.get(next.id);
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
    sessions.set(next.id, next);
    broadcast({ type: 'upsert', session: next });
  },
  remove(id) {
    if (sessions.delete(id)) broadcast({ type: 'remove', id });
    if (id in acks) {
      delete acks[id];
      saveAcks();
    }
  },
  isAcked: (id, since) => acks[id] === since,
});

function loadToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    const t = crypto.randomBytes(9).toString('base64url');
    fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
    return t;
  }
}

function loadAcks() {
  try {
    return JSON.parse(fs.readFileSync(ACKS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveAcks() {
  fs.writeFile(ACKS_FILE, JSON.stringify(acks), () => {});
}

function loadState() {
  try {
    const saved = Object.entries(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
    // Orca sessions are re-read from Orca on startup.
    return new Map(saved.filter(([, s]) => s.via !== 'orca'));
  } catch {
    return new Map();
  }
}

function stateJson() {
  const own = [...sessions].filter(([, s]) => s.via !== 'orca');
  return JSON.stringify(Object.fromEntries(own), null, 1);
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(STATE_FILE, stateJson(), () => {}), 500);
}

// launchd stops the service with SIGTERM; persist pending changes first.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    fs.writeFileSync(STATE_FILE, stateJson());
    fs.writeFileSync(ACKS_FILE, JSON.stringify(acks));
    process.exit(0);
  });
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function describeTool(name, input) {
  if (!input || typeof input !== 'object') return name;
  const detail = input.command || input.description || input.file_path || input.pattern
    || input.url || input.query || input.prompt || input.path;
  return detail ? `${name}: ${truncate(String(detail), 80)}` : name;
}

function isBackgroundStart(name, input) {
  if (WAKEUP_TOOLS.has(name)) return true;
  return !!(input && (input.run_in_background === true || input.is_background === true));
}

function setStatus(s, status, detail) {
  if (s.status !== status) s.since = Date.now();
  s.status = status;
  if (detail !== undefined) s.detail = detail;
}

function applyEvent(evt) {
  const p = evt.payload || {};
  const id = p.session_id;
  if (!id) return;
  // Sessions inside Orca are tracked through the Orca CLI, which knows more (titles, sub-agents, monitors).
  if (evt.term && evt.term.orcaPane && orca.isHealthy()) return;
  const now = Date.now();
  let s = sessions.get(id);
  if (!s) {
    s = { id, source: evt.source, status: 'idle', since: now, detail: '', prompt: '', bg: 0, created: now };
    sessions.set(id, s);
  }
  s.source = evt.source || s.source;
  s.cwd = p.cwd || s.cwd || '';
  s.project = path.basename(s.cwd || '') || '?';
  if (evt.pid > 1) s.pid = evt.pid;
  s.term = evt.term || s.term;
  s.updated = now;
  const prevEvent = s.lastEvent;
  s.lastEvent = p.hook_event_name;

  const tool = p.tool_name;
  const input = p.tool_input;

  switch (p.hook_event_name) {
    case 'SessionStart':
      s.bg = 0;
      setStatus(s, 'idle', p.source ? `Session ${p.source}` : 'Session gestartet');
      break;
    case 'UserPromptSubmit':
      s.prompt = truncate(p.prompt, 300);
      setStatus(s, 'working', 'Prompt erhalten');
      break;
    case 'PreToolUse':
      // Activity right after a stop without a new prompt means a background task woke the agent.
      if (prevEvent === 'Stop' && s.bg > 0) s.bg--;
      if (ASKING_TOOLS.has(tool)) {
        setStatus(s, 'waiting', tool === 'AskUserQuestion' ? 'Stellt eine Frage' : 'Plan zur Freigabe');
      } else {
        if (tool === 'TaskStop' && s.bg > 0) s.bg--;
        if (isBackgroundStart(tool, input)) s.bg++;
        setStatus(s, 'working', describeTool(tool, input));
      }
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      setStatus(s, 'working', describeTool(tool, input));
      break;
    case 'PermissionRequest':
      setStatus(s, 'waiting', 'Freigabe: ' + describeTool(tool, input));
      break;
    case 'Notification': {
      const type = p.notification_type || '';
      if (type === 'permission_prompt' || type === 'elicitation_dialog') {
        setStatus(s, 'waiting', truncate(p.message, 120) || 'Wartet auf Eingabe');
      } else if (type === 'idle_prompt' && s.status === 'working') {
        setStatus(s, 'done', truncate(p.message, 120));
      }
      break;
    }
    case 'Stop':
      if (s.bg > 0) setStatus(s, 'background', `${s.bg} Hintergrund-Task${s.bg > 1 ? 's' : ''} aktiv`);
      else setStatus(s, 'done', 'Fertig');
      break;
    case 'StopFailure':
      setStatus(s, 'error', truncate(p.error || p.message || 'Abbruch mit Fehler', 120));
      break;
    case 'SessionEnd':
      s.bg = 0;
      setStatus(s, 'ended', p.reason ? `Beendet (${p.reason})` : 'Beendet');
      break;
    default:
      return;
  }
  broadcast({ type: 'upsert', session: s });
  saveState();
}

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(data);
}

function checkLiveness() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.status === 'ended') {
      if (now - s.since > ENDED_TTL_MS) {
        sessions.delete(s.id);
        broadcast({ type: 'remove', id: s.id });
        saveState();
      }
      continue;
    }
    if (!s.pid) continue;
    try {
      process.kill(s.pid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') {
        s.bg = 0;
        setStatus(s, 'ended', 'Prozess beendet');
        broadcast({ type: 'upsert', session: s });
        saveState();
      }
    }
  }
}

// ---------- actions ----------

async function runAction(s, action, body) {
  switch (action) {
    case 'ack':
      if (s.via === 'orca') {
        // Orca re-reports the state on every poll; remember which state was acknowledged.
        if (s.status === 'done' || s.status === 'error') {
          acks[s.id] = s.since;
          saveAcks();
          s.status = 'idle';
        }
      } else if (s.status === 'done' || s.status === 'error' || s.status === 'background') {
        s.bg = 0;
        setStatus(s, 'idle', 'Gesehen');
      }
      broadcast({ type: 'upsert', session: s });
      saveState();
      return {};
    case 'remove':
      if (s.via === 'orca') throw new Error('Orca-Sessions verschwinden mit ihrem Terminal');
      sessions.delete(s.id);
      broadcast({ type: 'remove', id: s.id });
      saveState();
      return {};
    case 'focus':
      requireOrca(s);
      await orca.focus(s.orcaPane);
      return {};
    case 'screen':
      requireOrca(s);
      return { lines: await orca.screen(s.orcaPane) };
    case 'close':
      requireOrca(s);
      await orca.close(s.orcaPane);
      return {};
    case 'send':
      requireOrca(s);
      await orca.send(s.orcaPane, {
        text: typeof body.text === 'string' ? body.text : undefined,
        key: typeof body.key === 'string' ? body.key : undefined,
      });
      return {};
    default:
      throw new Error(`Unbekannte Aktion: ${action}`);
  }
}

function requireOrca(s) {
  if (!s.orcaPane) throw new Error('Nur für Sessions in Orca verfügbar');
}

// ---------- network allow-list ----------

function ipToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !(p >= 0 && p <= 255))) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function parseCidr(cidr) {
  const [ip, bits = '32'] = cidr.trim().split('/');
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return { net: (ipToInt(ip) & mask) >>> 0, mask };
}

function allowedAddress(addr) {
  const ip = ipToInt(String(addr || '').replace(/^::ffff:/, ''));
  return ip !== null && ALLOW.some(({ net, mask }) => ((ip & mask) >>> 0) === net);
}

function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- http ----------

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

const ACTIONS = { ack: 'POST', remove: 'POST', focus: 'POST', send: 'POST', close: 'POST', screen: 'GET' };

const server = http.createServer(async (req, res) => {
  if (!allowedAddress(req.socket.remoteAddress)) {
    req.socket.destroy();
    return;
  }
  const url = new URL(req.url, 'http://x');

  try {
    if (req.method === 'POST' && url.pathname === '/event') {
      if (!isLoopback(req)) { res.writeHead(403).end(); return; }
      applyEvent(JSON.parse(await readBody(req)));
      res.writeHead(204).end();
      return;
    }

    const cookie = /(?:^|;\s*)tm_token=([^;]+)/.exec(req.headers.cookie || '');
    const queryToken = url.searchParams.get('token');
    const hasToken = safeEqual(queryToken, token) || (cookie && safeEqual(cookie[1], token));
    if (!hasToken && !isLoopback(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Token fehlt: /?token=…');
      return;
    }
    if (queryToken && hasToken) {
      res.setHeader('Set-Cookie', `tm_token=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`);
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'snapshot', sessions: [...sessions.values()], now: Date.now() })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    const m = /^\/api\/sessions\/([^/]+)\/([a-z]+)$/.exec(url.pathname);
    if (m && Object.hasOwn(ACTIONS, m[2])) {
      if (req.method !== ACTIONS[m[2]]) { res.writeHead(405).end(); return; }
      const s = sessions.get(decodeURIComponent(m[1]));
      if (!s) { json(res, 404, { error: 'Session nicht gefunden' }); return; }
      const body = m[2] === 'send' ? JSON.parse(await readBody(req, 16 << 10)) : {};
      try {
        json(res, 200, await runAction(s, m[2], body));
      } catch (e) {
        json(res, 502, { error: e.message });
      }
      return;
    }

    if (req.method === 'GET') { serveStatic(res, url.pathname); return; }
    res.writeHead(405).end();
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: e.message });
  }
});

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && allowedAddress(i.address))
    .map((i) => i.address);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Taskmonitor läuft auf Port ${PORT} (erlaubt: ${ALLOW_SPEC})`);
  console.log(`  lokal:  http://localhost:${PORT}/`);
  for (const ip of lanAddresses()) console.log(`  iPad:   http://${ip}:${PORT}/?token=${token}`);
});
setInterval(checkLiveness, LIVENESS_INTERVAL_MS);
