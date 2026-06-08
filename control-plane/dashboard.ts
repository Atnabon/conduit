// The control-plane dashboard — a single self-contained HTML page served at `/`.
// Vanilla JS talks to the `/api/*` routes. No build step, no framework.
// Color palette, typography, and animation tokens mirror source-code-full globals.css.

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>conduit — control plane</title>
<style>
  /* ── Design tokens (zinc dark palette, source-code-full globals.css) ── */
  :root {
    --bg-primary:   #09090b;
    --bg-secondary: #18181b;
    --bg-elevated:  #27272a;
    --border:       #27272a;
    --border-hover: #3f3f46;
    --text:         #fafafa;
    --text-muted:   #a1a1aa;
    --text-faint:   #52525b;
    --accent:       #8b5cf6;
    --accent-hover: #7c3aed;
    --accent-fg:    #ffffff;
    --allow:        #22c55e;
    --allow-bg:     rgba(34,197,94,0.12);
    --deny:         #ef4444;
    --deny-bg:      rgba(239,68,68,0.12);
    --ask:          #f59e0b;
    --ask-bg:       rgba(245,158,11,0.12);
    --shadow-sm:    0 1px 2px rgba(0,0,0,.5);
    --shadow-md:    0 4px 6px -1px rgba(0,0,0,.5), 0 2px 4px -2px rgba(0,0,0,.3);
    --radius-sm:    .25rem;
    --radius-md:    .375rem;
    --radius-lg:    .5rem;
    --radius-xl:    .75rem;
    --transition-fast:   100ms ease;
    --transition-normal: 200ms ease;
  }

  /* ── Reset ── */
  *, *::before, *::after { box-sizing: border-box; margin: 0; }

  /* ── Base ── */
  html { color-scheme: dark; }
  body {
    background: var(--bg-primary);
    color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: .875rem;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    min-height: 100dvh;
  }
  a { color: inherit; text-decoration: none; }
  code, pre {
    font-family: "JetBrains Mono", "SF Mono", "Fira Code", ui-monospace, monospace;
    font-size: .8125rem;
  }

  /* ── Scrollbar ── */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border-hover); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--text-faint); }

  /* ── Focus ring ── */
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* ── Animations ── */
  @keyframes fadeIn  { from { opacity: 0 } to { opacity: 1 } }
  @keyframes slideUp { from { transform: translateY(6px); opacity: 0 } to { transform: none; opacity: 1 } }
  @keyframes pulse   { 0%,100% { opacity: 1 } 50% { opacity: .4 } }

  /* ── Layout ── */
  .layout {
    display: grid;
    grid-template-rows: auto 1fr;
    min-height: 100dvh;
  }

  /* ── Top bar ── */
  .topbar {
    position: sticky; top: 0; z-index: 10;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    padding: .75rem clamp(1rem, 3vw, 2rem);
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    flex-wrap: wrap;
    backdrop-filter: blur(8px);
  }
  .wordmark {
    font-size: 1rem; font-weight: 600; letter-spacing: -.02em;
    display: flex; align-items: center; gap: .45rem;
  }
  .wordmark-mark { color: var(--accent); font-size: 1.2em; line-height: 1; }
  .wordmark-sub  { color: var(--text-muted); font-weight: 400; font-size: .8rem; }
  .topbar-right  { display: flex; align-items: center; gap: .75rem; }

  /* ── Integrity badge ── */
  .badge {
    display: inline-flex; align-items: center; gap: .35rem;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: .75rem; font-weight: 600;
    padding: .28rem .65rem;
    border-radius: 999px;
    letter-spacing: .02em;
  }
  .badge-dot {
    width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
  }
  .badge.ok  { background: var(--allow-bg); color: var(--allow); }
  .badge.ok  .badge-dot { background: var(--allow); animation: pulse 2s ease infinite; }
  .badge.bad { background: var(--deny-bg);  color: var(--deny); }
  .badge.bad .badge-dot { background: var(--deny); }

  /* ── Live indicator ── */
  .live-indicator {
    display: inline-flex; align-items: center; gap: .4rem;
    font-size: .75rem; color: var(--text-muted);
  }
  .live-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--allow); animation: pulse 2.4s ease infinite;
  }

  /* ── Main content ── */
  .main {
    padding: clamp(1rem, 3vw, 2rem);
    max-width: 1120px; margin-inline: auto; width: 100%;
    display: flex; flex-direction: column; gap: 1rem;
  }

  /* ── Panel ── */
  .panel {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    padding: 1.1rem 1.25rem;
    box-shadow: var(--shadow-sm);
    animation: slideUp 220ms ease both;
  }
  .panel-head {
    display: flex; align-items: center; justify-content: space-between;
    gap: .75rem; margin-bottom: .75rem; flex-wrap: wrap;
  }
  .panel-title {
    font-size: .72rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: .1em; color: var(--text-muted);
  }

  /* ── Tables ── */
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; color: var(--text-faint); font-weight: 500;
    padding: .3rem .55rem .3rem 0; font-size: .75rem;
    border-bottom: 1px solid var(--border);
  }
  td {
    padding: .38rem .55rem .38rem 0;
    border-bottom: 1px solid var(--border);
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: .8rem;
    white-space: nowrap;
  }
  tr:last-child td { border-bottom: 0; }

  /* ── Status tokens ── */
  .allow { color: var(--allow); }
  .deny  { color: var(--deny); }
  .ask   { color: var(--ask); }
  .dim   { color: var(--text-muted); }
  .faint { color: var(--text-faint); }
  .chip  {
    display: inline-block; font-size: .72rem; font-weight: 600;
    padding: .15rem .45rem; border-radius: 999px; font-family: ui-monospace, monospace;
  }
  .chip-allow { background: var(--allow-bg); color: var(--allow); }
  .chip-deny  { background: var(--deny-bg);  color: var(--deny); }
  .chip-ask   { background: var(--ask-bg);   color: var(--ask); }

  /* ── Form controls ── */
  input, select, button { font: inherit; }
  input, select {
    background: var(--bg-primary); color: var(--text);
    border: 1px solid var(--border); border-radius: var(--radius-md);
    padding: .35rem .55rem;
    transition: border-color var(--transition-fast);
  }
  input:focus, select:focus { border-color: var(--accent); outline: none; }
  button {
    background: var(--accent); color: var(--accent-fg); border: 0; cursor: pointer;
    border-radius: var(--radius-md); padding: .38rem .9rem; font-weight: 600;
    transition: background var(--transition-fast), opacity var(--transition-fast);
  }
  button:hover  { background: var(--accent-hover); }
  button:active { opacity: .85; }
  button.ghost  {
    background: transparent; color: var(--accent);
    border: 1px solid var(--border);
  }
  button.ghost:hover { border-color: var(--border-hover); background: var(--bg-elevated); }
  button.danger { background: var(--deny-bg); color: var(--deny); border: 1px solid transparent; }
  button.danger:hover { background: var(--deny); color: #fff; }
  button.sm { font-size: .75rem; padding: .28rem .65rem; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }

  /* ── Two-column grid on wide screens ── */
  @media (min-width: 860px) {
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  }
</style>
</head>
<body>
<div class="layout">

<header class="topbar">
  <div class="wordmark">
    <span class="wordmark-mark" aria-hidden="true">⌁</span>
    conduit
    <span class="wordmark-sub">// control plane</span>
  </div>
  <div class="topbar-right">
    <span class="live-indicator">
      <span class="live-dot" aria-hidden="true"></span>
      live
    </span>
    <span id="integrity" class="badge">
      <span class="badge-dot" aria-hidden="true"></span>
      checking…
    </span>
    <button class="ghost sm" onclick="window.open('/api/compliance-report.txt')">
      Compliance report
    </button>
  </div>
</header>

<main class="main" id="main">

  <!-- Agents + Approvals row -->
  <div class="grid-2">
    <section class="panel" aria-labelledby="agents-heading">
      <div class="panel-head">
        <h2 class="panel-title" id="agents-heading">Registered agents</h2>
      </div>
      <table>
        <thead><tr><th>agentId</th><th>label</th><th>registered</th></tr></thead>
        <tbody id="agents"></tbody>
      </table>
    </section>

    <section class="panel" aria-labelledby="approvals-heading">
      <div class="panel-head">
        <h2 class="panel-title" id="approvals-heading">Pending approvals</h2>
      </div>
      <table>
        <thead><tr><th>agent</th><th>action</th><th>reason</th><th></th></tr></thead>
        <tbody id="approvals"></tbody>
      </table>
    </section>
  </div>

  <!-- Rules -->
  <section class="panel" aria-labelledby="rules-heading">
    <div class="panel-head">
      <h2 class="panel-title" id="rules-heading">Policy rules</h2>
    </div>
    <table>
      <thead><tr><th>action</th><th>behavior</th><th>note</th></tr></thead>
      <tbody id="rules"></tbody>
    </table>
    <div class="row" style="margin-top:.85rem">
      <input id="r-action" placeholder="action e.g. payment.*" style="flex:1;min-width:140px" />
      <select id="r-behavior">
        <option>allow</option><option>deny</option><option selected>ask</option>
      </select>
      <input id="r-note" placeholder="note (optional)" style="flex:1;min-width:120px" />
      <button onclick="addRule()">Add rule</button>
    </div>
  </section>

  <!-- Capabilities -->
  <section class="panel" aria-labelledby="caps-heading">
    <div class="panel-head">
      <h2 class="panel-title" id="caps-heading">Capabilities</h2>
      <div class="row">
        <input id="c-agent" placeholder="agentId" style="min-width:180px" />
        <button class="ghost sm" onclick="loadCaps()">Look up</button>
      </div>
    </div>
    <table>
      <thead><tr><th>id</th><th>action</th><th>constraints</th><th>status</th></tr></thead>
      <tbody id="caps"></tbody>
    </table>
  </section>

  <!-- Audit trail -->
  <section class="panel" aria-labelledby="audit-heading">
    <div class="panel-head">
      <h2 class="panel-title" id="audit-heading">Audit trail</h2>
      <span id="chain-status" class="dim" style="font-size:.75rem"></span>
    </div>
    <table>
      <thead><tr><th>#</th><th>type</th><th>agent</th><th>detail</th><th>hash</th></tr></thead>
      <tbody id="audit"></tbody>
    </table>
  </section>

</main>
</div>

<script>
const api = (p, opts) => fetch('/api/' + p, opts).then(r => r.json());
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);

async function refreshIntegrity() {
  const v = await api('audit/verify');
  const el = document.getElementById('integrity');
  const cs = document.getElementById('chain-status');
  if (v.valid) {
    el.className = 'badge ok';
    el.innerHTML = '<span class="badge-dot" aria-hidden="true"></span>CHAIN VERIFIED · ' + v.length + ' events';
    if (cs) cs.textContent = v.length + ' events · chain intact';
  } else {
    el.className = 'badge bad';
    el.innerHTML = '<span class="badge-dot" aria-hidden="true"></span>CHAIN BROKEN @ #' + v.brokenAt;
    if (cs) { cs.textContent = 'broken at #' + v.brokenAt; cs.style.color = 'var(--deny)'; }
  }
}

async function loadRules() {
  const rules = await api('rules');
  document.getElementById('rules').innerHTML = rules.map(r =>
    '<tr><td>' + esc(r.action) + '</td>' +
    '<td><span class="chip chip-' + r.behavior + '">' + r.behavior + '</span></td>' +
    '<td class="dim">' + esc(r.note || '') + '</td></tr>'
  ).join('') || '<tr><td class="faint" colspan="3">no rules configured</td></tr>';
}

async function addRule() {
  const action = document.getElementById('r-action').value.trim();
  if (!action) return;
  await api('rules', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action,
      behavior: document.getElementById('r-behavior').value,
      note: document.getElementById('r-note').value,
    }),
  });
  document.getElementById('r-action').value = '';
  document.getElementById('r-note').value = '';
  loadRules();
}

async function loadAgents() {
  let agents = [];
  try { agents = await api('agents'); } catch { return; }
  document.getElementById('agents').innerHTML = agents.map(a =>
    '<tr>' +
    '<td>' + esc(a.agentId) + '</td>' +
    '<td class="dim">' + esc(a.label || '—') + '</td>' +
    '<td class="faint">' + new Date(a.registeredAt).toLocaleDateString() + '</td>' +
    '</tr>'
  ).join('') || '<tr><td class="faint" colspan="3">no agents registered</td></tr>';
}

async function loadCaps() {
  const agentId = document.getElementById('c-agent').value.trim();
  if (!agentId) return;
  const caps = await api('capabilities?agentId=' + encodeURIComponent(agentId));
  document.getElementById('caps').innerHTML = caps.map(c => {
    const statusChip = c.revokedAt
      ? '<span class="chip chip-deny">revoked</span>'
      : '<span class="chip chip-allow">active</span>';
    return '<tr>' +
      '<td class="faint">' + esc(c.id.slice(0, 16)) + '…</td>' +
      '<td>' + esc(c.action) + '</td>' +
      '<td class="dim">' + esc(JSON.stringify(c.constraints)) + '</td>' +
      '<td>' + statusChip + '</td>' +
      '</tr>';
  }).join('') || '<tr><td class="faint" colspan="4">no capabilities found</td></tr>';
}

async function loadAudit() {
  const events = await api('audit?limit=50');
  document.getElementById('audit').innerHTML = events.slice().reverse().map(e => {
    let detail = '';
    if (e.type === 'authorize' && e.payload?.decision) {
      const b = e.payload.decision.behavior;
      detail = '<span class="chip chip-' + b + '">' + b + '</span> ' + esc(e.payload.action || '');
    } else if (e.payload?.action) {
      detail = esc(e.payload.action);
    } else if (e.payload?.capabilityId) {
      detail = esc(String(e.payload.capabilityId).slice(0, 20));
    }
    return '<tr>' +
      '<td class="faint">' + e.seq + '</td>' +
      '<td class="dim">' + esc(e.type) + '</td>' +
      '<td class="faint">' + esc(e.agentId) + '</td>' +
      '<td>' + detail + '</td>' +
      '<td class="faint">' + e.hash.slice(0, 10) + '…</td>' +
      '</tr>';
  }).join('') || '<tr><td class="faint" colspan="5">no events</td></tr>';
}

async function loadApprovals() {
  const pending = await api('approvals');
  document.getElementById('approvals').innerHTML = pending.map(a =>
    '<tr>' +
    '<td class="dim">' + esc(a.agentId) + '</td>' +
    '<td>' + esc(a.action) + '</td>' +
    '<td class="faint">' + esc(a.reason) + '</td>' +
    '<td class="row">' +
    '<button class="sm" onclick="resolveApproval(\\'' + esc(a.id) + '\\',\\'approve\\')">Approve</button>' +
    '<button class="ghost sm danger" onclick="resolveApproval(\\'' + esc(a.id) + '\\',\\'reject\\')">Reject</button>' +
    '</td></tr>'
  ).join('') || '<tr><td class="faint" colspan="4">no pending approvals</td></tr>';
}

async function resolveApproval(id, verb) {
  await api('approvals/' + id + '/' + verb, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approvedBy: 'dashboard', rejectedBy: 'dashboard' }),
  });
  refreshAll();
}

function refreshAll() {
  refreshIntegrity();
  loadRules();
  loadAgents();
  loadApprovals();
  loadAudit();
}

refreshAll();
setInterval(refreshAll, 5000);
</script>
</body>
</html>`;
