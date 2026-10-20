// Orca integration: polls the Orca CLI for agent state per terminal pane and
// exposes actions (bring a terminal to the foreground, read its screen).
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ORCA_CLI = process.env.ORCA_CLI || '/Applications/Orca.app/Contents/Resources/bin/orca';
const POLL_MS = 2000;
const TERMINAL_LIST_EVERY = 3; // refresh handles/titles every n-th poll
const HANDLE_RE = /^term_[A-Za-z0-9-]+$/;

// Orca agent state -> deck status
function mapState(agent) {
  switch (agent.state) {
    case 'blocked':
    case 'waiting': return 'waiting';
    case 'working': return agent.workingMode === 'monitoring' ? 'background' : 'working';
    case 'done': return 'done';
    case 'error': return 'error';
    default: return 'idle';
  }
}

function sourceOf(agentType) {
  const t = String(agentType || '').toLowerCase();
  if (t.includes('qwen')) return 'qwen';
  if (t.includes('claude')) return 'claude';
  return t || 'agent';
}

function cleanTitle(title) {
  // Agents prefix the tab title with a spinner/status glyph.
  const t = String(title || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  // Default titles carry no information about the task.
  return /^(claude( code)?|qwen( code)?)$/i.test(t) ? '' : t;
}

function oneLine(s, n) {
  if (typeof s !== 'string') return '';
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function runOrca(args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile(ORCA_CLI, [...args, '--json'], { timeout, maxBuffer: 8 << 20 }, (err, stdout) => {
      let parsed;
      try { parsed = JSON.parse(stdout); } catch { parsed = null; }
      if (parsed && parsed.ok) resolve(parsed.result);
      else reject(new Error((parsed && parsed.error && (parsed.error.message || parsed.error)) || (err && err.message) || 'orca failed'));
    });
  });
}

function createOrcaAdapter({ upsert, remove, isAcked }) {
  const available = fs.existsSync(ORCA_CLI);
  const terminals = new Map(); // paneKey -> { handle, title }
  const known = new Set(); // session ids currently provided by Orca
  let healthy = false;
  let polls = 0;
  let busy = false;

  async function refreshTerminals() {
    const result = await runOrca(['terminal', 'list', '--limit', '1000']);
    terminals.clear();
    for (const t of result.terminals || []) {
      // Terminals the UI has not adopted yet are "orphaned" and only carry their pane key as recordedPaneKey.
      const paneKey = t.recordedPaneKey || (t.tabId && t.leafId ? `${t.tabId}:${t.leafId}` : null);
      if (paneKey) terminals.set(paneKey, { handle: t.handle, title: cleanTitle(t.title) });
    }
  }

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      if (polls++ % TERMINAL_LIST_EVERY === 0) await refreshTerminals();
      const result = await runOrca(['worktree', 'ps']);
      const seen = new Set();
      for (const w of result.worktrees || []) {
        for (const a of w.agents || []) {
          if (!a.paneKey || a.parentPaneKey) continue; // skip sub-agents, the main pane represents them
          const id = `orca:${a.paneKey}`;
          const term = terminals.get(a.paneKey) || {};
          let status = mapState(a);
          if ((status === 'done' || status === 'error') && isAcked(id, a.stateStartedAt)) status = 'idle';
          const detail = status === 'waiting'
            ? (a.toolName ? `Freigabe: ${a.toolName}${a.toolInput ? ': ' + oneLine(a.toolInput, 80) : ''}` : 'Wartet auf Eingabe')
            : status === 'working' || status === 'background'
              ? (a.toolName ? `${a.toolName}${a.toolInput ? ': ' + oneLine(a.toolInput, 80) : ''}` : 'Arbeitet')
              : a.interrupted ? 'Abgebrochen' : '';
          seen.add(id);
          upsert({
            id,
            via: 'orca',
            source: sourceOf(a.agentType),
            status,
            since: a.stateStartedAt || a.updatedAt || Date.now(),
            project: w.repo || path.basename(w.path || '') || '?',
            branch: String(w.branch || '').replace(/^refs\/heads\//, ''),
            cwd: w.path || '',
            task: a.taskTitle || a.displayName || term.title || '',
            detail,
            prompt: oneLine(a.prompt, 300),
            lastMessage: oneLine(a.lastAssistantMessage, 600),
            orcaHandle: term.handle || null,
            orcaPane: a.paneKey,
            term: { orcaPane: a.paneKey },
          });
        }
      }
      for (const id of known) if (!seen.has(id)) remove(id);
      known.clear();
      for (const id of seen) known.add(id);
      healthy = true;
    } catch (e) {
      if (healthy) console.warn('Orca nicht erreichbar:', e.message);
      healthy = false;
    } finally {
      busy = false;
    }
  }

  async function handleFor(paneKey) {
    // A freshly started agent may not be in the cached terminal list yet.
    if (!terminals.has(paneKey)) await refreshTerminals();
    const h = terminals.get(paneKey)?.handle;
    if (!h || !HANDLE_RE.test(h)) throw new Error('Kein Orca-Terminal für diese Session');
    return h;
  }

  async function focus(paneKey) {
    await runOrca(['terminal', 'switch', '--terminal', await handleFor(paneKey)]);
    execFile('open', ['-a', 'Orca'], () => {});
  }

  async function screen(paneKey) {
    const result = await runOrca(['terminal', 'read', '--terminal', await handleFor(paneKey), '--screen']);
    const tail = result.terminal?.tail || [];
    // Drop trailing empty rows so the preview ends at the prompt.
    while (tail.length && !tail[tail.length - 1].trim()) tail.pop();
    return tail;
  }

  async function close(paneKey) {
    const handle = await handleFor(paneKey);
    try {
      await runOrca(['terminal', 'close', '--terminal', handle]);
    } catch (e) {
      // Orca closes terminals the UI has not adopted yet but still reports tab_not_found; trust the terminal list.
      await refreshTerminals();
      if (terminals.has(paneKey)) throw e;
    }
    terminals.delete(paneKey);
    remove(`orca:${paneKey}`);
  }

  // Single keys as the terminal would receive them (verified byte-exact against `od -c`).
  const KEYS = { '1': '1', '2': '2', '3': '3', enter: '\r', esc: '\x1b' };

  async function send(paneKey, { text, key }) {
    const handle = await handleFor(paneKey);
    let args;
    if (key === 'interrupt') {
      args = ['--interrupt'];
    } else if (key) {
      if (!Object.hasOwn(KEYS, key)) throw new Error(`Unbekannte Taste: ${key}`);
      args = ['--text', KEYS[key]];
    } else {
      if (typeof text !== 'string' || !text.trim()) throw new Error('Kein Text');
      if (text.length > 4000) throw new Error('Text zu lang');
      args = ['--text', text, '--enter'];
    }
    await runOrca(['terminal', 'send', '--terminal', handle, ...args]);
  }

  if (available) {
    poll();
    setInterval(poll, POLL_MS);
  }

  return {
    available,
    isHealthy: () => healthy,
    focus,
    screen,
    send,
    close,
  };
}

module.exports = { createOrcaAdapter };
