'use strict';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const HISTORY_LIMIT = 100;
const HIGHLIGHT_LIMIT = 2 * 1024 * 1024;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => Math.random().toString(36).slice(2, 10);
const clone = (o) => structuredClone(o);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function blankRequest() {
  return {
    id: null,
    name: '',
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    bodyType: 'none',
    body: '',
    form: [],
    auth: { type: 'none', token: '', user: '', pass: '' },
  };
}

// ── State ──────────────────────────────────────────────

let state = { requests: [], history: [], envs: [], activeEnv: null, drafts: {}, draft: null };
let cur = blankRequest();
const responses = {}; // in-memory last response per request id ('' for unsaved)
const ui = { side: 'saved', reqTab: 'params', resTab: 'body', pretty: true };
let inflight = null;

function api(path, opts = {}) {
  return fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-rest-client': '1', ...opts.headers },
  });
}

let persistTimer;
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 400);
}
function persist(keepalive = false) {
  clearTimeout(persistTimer);
  state.draft = cur;
  return api('/api/state', { method: 'PUT', body: JSON.stringify(state), keepalive }).catch(() => {});
}

const savedById = (id) => state.requests.find((r) => r.id === id);

function isDirty() {
  const saved = cur.id && savedById(cur.id);
  if (!saved) return !!(cur.url.trim() || cur.name.trim());
  return JSON.stringify(cur) !== JSON.stringify(saved);
}

// ── Environments & variables ───────────────────────────

function envVars() {
  const env = state.envs.find((e) => e.id === state.activeEnv);
  const vars = {};
  if (env) for (const v of env.vars) if (v.on && v.k) vars[v.k] = v.v;
  return vars;
}

function substitute(str, vars) {
  return (str || '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, name) => (name in vars ? vars[name] : m));
}

// ── Key/value editor ───────────────────────────────────

function renderKV(container, rows, onChange, placeholders = ['key', 'value']) {
  container.innerHTML = '';
  const wrap = el('div', 'kv');

  const addRow = (row) => {
    const r = el('div', 'kv-row');
    const on = el('input', 'kv-on'); on.type = 'checkbox';
    const k = el('input', 'kv-k'); k.placeholder = placeholders[0]; k.spellcheck = false;
    const v = el('input', 'kv-v'); v.placeholder = placeholders[1]; v.spellcheck = false;
    const del = el('button', 'kv-del', '✕'); del.type = 'button'; del.title = 'Remove';
    r.append(on, k, v, del);

    let data = row;
    if (data) {
      on.checked = data.on; k.value = data.k; v.value = data.v;
      r.classList.toggle('off', !data.on);
    } else {
      on.checked = true;
      r.classList.add('phantom');
    }

    const ensure = () => {
      if (data) return;
      data = { k: '', v: '', on: true };
      rows.push(data);
      r.classList.remove('phantom');
      addRow(null);
    };
    k.oninput = () => { ensure(); data.k = k.value; onChange(); };
    v.oninput = () => { ensure(); data.v = v.value; onChange(); };
    on.onchange = () => {
      if (!data) return;
      data.on = on.checked;
      r.classList.toggle('off', !data.on);
      onChange();
    };
    del.onclick = () => {
      if (!data) return;
      rows.splice(rows.indexOf(data), 1);
      r.remove();
      onChange();
    };
    wrap.append(r);
  };

  rows.forEach(addRow);
  addRow(null);
  container.append(wrap);
}

// ── URL <-> params ─────────────────────────────────────

function parseQuery(url) {
  const i = url.indexOf('?');
  if (i < 0) return [];
  let q = url.slice(i + 1);
  const hash = q.indexOf('#');
  if (hash >= 0) q = q.slice(0, hash);
  return q.split('&').filter(Boolean).map((part) => {
    const j = part.indexOf('=');
    return j < 0 ? { k: part, v: '', on: true } : { k: part.slice(0, j), v: part.slice(j + 1), on: true };
  });
}

function syncParamsFromUrl() {
  cur.params = [...parseQuery(cur.url), ...cur.params.filter((p) => !p.on)];
  renderKV($('.req-pane [data-panel="params"]'), cur.params, onParamsChange);
}

function onParamsChange() {
  const base = cur.url.split('?')[0];
  const q = cur.params
    .filter((p) => p.on && p.k)
    .map((p) => (p.v === '' ? p.k : `${p.k}=${p.v}`))
    .join('&');
  cur.url = q ? `${base}?${q}` : base;
  $('#url').value = cur.url;
  changed();
}

// ── Editor ─────────────────────────────────────────────

function changed() {
  $('#dirty').hidden = !isDirty();
  updateCounts();
  persistSoon();
}

function updateCounts() {
  const n = (rows) => rows.filter((r) => r.on && r.k).length || '';
  $('#req-tabs [data-tab="params"] .count').textContent = n(cur.params);
  $('#req-tabs [data-tab="headers"] .count').textContent = n(cur.headers);
}

function setMethodClass() {
  const m = $('#method');
  m.className = `m-${cur.method}`;
}

function renderBodyType() {
  const t = cur.bodyType;
  $$('input[name="body-type"]').forEach((r) => { r.checked = r.value === t; });
  $('#body-text').hidden = t !== 'json' && t !== 'text';
  $('#body-form').hidden = t !== 'form';
  $('#body-none').hidden = t !== 'none';
  $('#format-json').hidden = t !== 'json';
  $('#body-text').placeholder = t === 'json' ? '{\n  "name": "{{user}}"\n}' : '';
}

function renderAuth() {
  $('#auth-type').value = cur.auth.type;
  $$('[data-auth]').forEach((f) => { f.hidden = f.dataset.auth !== cur.auth.type; });
}

function renderEditor() {
  $('#req-name').value = cur.name;
  $('#method').value = cur.method;
  setMethodClass();
  $('#url').value = cur.url;
  renderKV($('.req-pane [data-panel="params"]'), cur.params, onParamsChange);
  renderKV($('.req-pane [data-panel="headers"]'), cur.headers, changed, ['header', 'value']);
  $('#body-text').value = cur.body;
  renderKV($('#body-form'), cur.form, changed);
  renderBodyType();
  $('#auth-token').value = cur.auth.token;
  $('#auth-user').value = cur.auth.user;
  $('#auth-pass').value = cur.auth.pass;
  renderAuth();
  $('#dirty').hidden = !isDirty();
  updateCounts();
  renderResponse();
}

function switchTab(tabsEl, panelsRoot, name) {
  $$(':scope > button', tabsEl).forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$(':scope > [data-panel]', panelsRoot).forEach((p) => { p.hidden = p.dataset.panel !== name; });
}

// ── Saved requests ─────────────────────────────────────

function stashCurrent() {
  if (cur.id && savedById(cur.id)) {
    if (isDirty()) state.drafts[cur.id] = clone(cur);
    else delete state.drafts[cur.id];
  }
}

function openRequest(id) {
  if (cur.id === id) return;
  stashCurrent();
  const saved = savedById(id);
  if (!saved) return;
  cur = clone(state.drafts[id] || saved);
  renderEditor();
  renderSidebar();
  persistSoon();
}

function newRequest() {
  stashCurrent();
  cur = blankRequest();
  delete responses[''];
  renderEditor();
  renderSidebar();
  persistSoon();
  $('#url').focus();
}

function deriveName() {
  try {
    const u = new URL(substitute(cur.url, envVars()));
    return `${cur.method} ${u.pathname}`;
  } catch {
    return cur.url.trim() || 'Untitled';
  }
}

function saveRequest() {
  if (!cur.name.trim()) cur.name = deriveName();
  if (cur.id && savedById(cur.id)) {
    const i = state.requests.findIndex((r) => r.id === cur.id);
    state.requests[i] = clone(cur);
  } else {
    cur.id = uid();
    if (responses['']) { responses[cur.id] = responses['']; delete responses['']; }
    state.requests.push(clone(cur));
  }
  delete state.drafts[cur.id];
  $('#req-name').value = cur.name;
  changed();
  renderSidebar();
  flash($('#save'), 'Saved');
}

function deleteRequest(id) {
  state.requests = state.requests.filter((r) => r.id !== id);
  delete state.drafts[id];
  delete responses[id];
  if (cur.id === id) {
    cur.id = null;
    changed();
  }
  renderSidebar();
  persistSoon();
}

function flash(btn, text) {
  const orig = btn.dataset.label || btn.textContent;
  btn.dataset.label = orig;
  btn.textContent = text;
  clearTimeout(btn._flash);
  btn._flash = setTimeout(() => { btn.textContent = orig; }, 1000);
}

// ── Sidebar ────────────────────────────────────────────

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function armDelete(btn, onConfirm) {
  btn.onclick = (e) => {
    e.stopPropagation();
    if (btn.classList.contains('armed')) return onConfirm();
    btn.classList.add('armed');
    btn.textContent = 'delete?';
  };
  btn.closest('.item').addEventListener('mouseleave', () => {
    btn.classList.remove('armed');
    btn.textContent = '✕';
  });
}

function renderSidebar() {
  const q = $('#search').value.trim().toLowerCase();
  const list = $('#side-list');
  list.innerHTML = '';
  $('#clear-history').hidden = ui.side !== 'history' || !state.history.length;

  if (ui.side === 'saved') {
    const items = state.requests.filter((r) => !q || `${r.name} ${r.url}`.toLowerCase().includes(q));
    if (!items.length) {
      list.append(el('p', 'muted center', state.requests.length ? 'No matches.' : 'No saved requests yet.'));
    }
    for (const r of items) {
      const item = el('div', `item${cur.id === r.id ? ' active' : ''}`,
        `<span class="m m-${esc(r.method)}">${esc(r.method)}</span><span class="label"></span><button class="del" title="Delete">✕</button>`);
      $('.label', item).textContent = r.name + (state.drafts[r.id] ? '  •' : '');
      item.title = r.url;
      item.onclick = () => openRequest(r.id);
      list.append(item);
      armDelete($('.del', item), () => deleteRequest(r.id));
    }
    return;
  }

  const items = state.history.filter((h) => !q || h.req.url.toLowerCase().includes(q));
  if (!items.length) {
    list.append(el('p', 'muted center', state.history.length ? 'No matches.' : 'Requests you send show up here.'));
  }
  for (const h of items) {
    const statusCls = h.status ? `s-${String(h.status)[0]}` : 's-err';
    const item = el('div', 'item history',
      `<span class="m m-${esc(h.req.method)}">${esc(h.req.method)}</span><span class="label"></span>` +
      `<span class="sub"><span class="${statusCls}">${esc(h.status || 'ERR')}</span> · ${timeAgo(h.at)}</span>`);
    $('.label', item).textContent = h.req.url.replace(/^https?:\/\//, '');
    item.title = `${h.req.url}\n${new Date(h.at).toLocaleString()}`;
    item.onclick = () => {
      stashCurrent();
      cur = clone(h.req);
      if (cur.id && !savedById(cur.id)) cur.id = null;
      renderEditor();
      renderSidebar();
      persistSoon();
    };
    list.append(item);
  }
}

// ── Sending ────────────────────────────────────────────

function utf8Base64(s) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

function buildRequest() {
  const vars = envVars();
  const sub = (s) => substitute(s, vars);

  let url = sub(cur.url.trim());
  if (!url) throw new Error('Enter a URL.');
  if (!/^[a-z][\w+.-]*:\/\//i.test(url)) url = `http://${url}`;
  url = new URL(url).toString();

  const headers = {};
  for (const h of cur.headers) if (h.on && h.k.trim()) headers[sub(h.k.trim())] = sub(h.v);
  const has = (name) => Object.keys(headers).some((k) => k.toLowerCase() === name);

  if (cur.auth.type === 'bearer' && cur.auth.token && !has('authorization')) {
    headers.Authorization = `Bearer ${sub(cur.auth.token)}`;
  } else if (cur.auth.type === 'basic' && !has('authorization')) {
    headers.Authorization = `Basic ${utf8Base64(`${sub(cur.auth.user)}:${sub(cur.auth.pass)}`)}`;
  }

  let body;
  if (cur.bodyType === 'json' || cur.bodyType === 'text') {
    body = sub(cur.body);
    if (!has('content-type')) headers['Content-Type'] = cur.bodyType === 'json' ? 'application/json' : 'text/plain';
  } else if (cur.bodyType === 'form') {
    const p = new URLSearchParams();
    for (const f of cur.form) if (f.on && f.k) p.append(sub(f.k), sub(f.v));
    body = p.toString();
    if (!has('content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  return { method: cur.method, url, headers, body };
}

async function send() {
  if (inflight) { inflight.abort(); return; }
  const key = cur.id || '';
  let payload;
  try {
    payload = buildRequest();
  } catch (e) {
    responses[key] = { error: e.message };
    renderResponse();
    return;
  }

  const snapshot = clone(cur);
  const ctrl = new AbortController();
  inflight = ctrl;
  $('#send').textContent = 'Cancel';
  $('#res-body').innerHTML = '<div class="loading">Sending…</div>';
  $('#res-meta').innerHTML = '';
  $('#res-tools').hidden = true;

  let result;
  try {
    const r = await api('/api/send', { method: 'POST', body: JSON.stringify(payload), signal: ctrl.signal });
    result = await r.json();
  } catch (e) {
    result = { error: e.name === 'AbortError' ? 'Request cancelled.' : `Could not reach the local server: ${e.message}` };
  } finally {
    inflight = null;
    $('#send').textContent = 'Send';
  }

  responses[key] = result;
  state.history.unshift({ id: uid(), at: Date.now(), status: result.status || 0, ms: result.ms, req: snapshot });
  state.history.length = Math.min(state.history.length, HISTORY_LIMIT);
  persistSoon();
  if ((cur.id || '') === key) renderResponse();
  if (ui.side === 'history') renderSidebar();
}

// ── Response ───────────────────────────────────────────

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatMs(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function highlightJSON(str) {
  return esc(str).replace(
    /(&quot;(?:\\u[a-fA-F0-9]{4}|\\[^u]|(?!&quot;)[^\\])*&quot;)(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (m, s, colon, bool) => {
      if (s) return colon ? `<span class="j-k">${s}</span>${colon}` : `<span class="j-s">${s}</span>`;
      if (bool) return `<span class="j-b">${m}</span>`;
      if (m === 'null') return `<span class="j-z">${m}</span>`;
      return `<span class="j-n">${m}</span>`;
    },
  );
}

function parseJSON(res) {
  if (res.encoding !== 'utf8' || !res.body) return undefined;
  const looksJson = /json/i.test(res.contentType) || /^\s*[[{]/.test(res.body);
  if (!looksJson) return undefined;
  try { return JSON.parse(res.body); } catch { return undefined; }
}

function renderResponse() {
  const res = responses[cur.id || ''];
  const body = $('#res-body');
  const meta = $('#res-meta');
  const tools = $('#res-tools');
  const hdrCount = $('#res-tabs [data-tab="headers"] .count');
  tools.hidden = true;
  hdrCount.textContent = '';
  $('#res-headers').innerHTML = '';

  if (!res) {
    meta.innerHTML = '';
    body.innerHTML = '<p class="muted center">Send a request to see the response.<br><kbd>Ctrl</kbd> + <kbd>Enter</kbd> to send · <kbd>Ctrl</kbd> + <kbd>S</kbd> to save</p>';
    return;
  }
  if (res.error) {
    meta.innerHTML = '<span class="status s-err">Error</span>';
    body.innerHTML = `<div class="res-error">${esc(res.error)}</div>`;
    return;
  }

  meta.innerHTML =
    `<span class="status s-${String(res.status)[0]}">${res.status} ${esc(res.statusText || '')}</span>` +
    `<span>${formatMs(res.ms)}</span><span>${formatSize(res.size)}</span>`;

  hdrCount.textContent = res.headers.length;
  const table = el('table', 'hdr-table');
  for (const [k, v] of res.headers) {
    const tr = table.insertRow();
    tr.insertCell().textContent = k;
    tr.insertCell().textContent = v;
  }
  $('#res-headers').append(table);

  if (!res.body) {
    body.innerHTML = '<p class="muted center">Empty response body.</p>';
    return;
  }
  tools.hidden = false;
  $('#copy-body').hidden = res.encoding === 'base64';
  $('#pretty-toggle').hidden = true;

  if (res.encoding === 'base64') {
    if (/^image\//i.test(res.contentType)) {
      body.innerHTML = `<img alt="" src="data:${esc(res.contentType)};base64,${res.body}">`;
    } else {
      body.innerHTML = `<p class="muted center">Binary response (${esc(res.contentType || 'unknown type')}, ${formatSize(res.size)})</p>`;
    }
    return;
  }

  const parsed = parseJSON(res);
  const isJson = parsed !== undefined;
  $('#pretty-toggle').hidden = !isJson;
  $('#pretty-toggle').textContent = ui.pretty ? 'Raw' : 'Pretty';

  const pre = el('pre');
  if (isJson && ui.pretty) {
    const text = JSON.stringify(parsed, null, 2);
    if (text.length < HIGHLIGHT_LIMIT) pre.innerHTML = highlightJSON(text);
    else pre.textContent = text;
  } else {
    pre.textContent = res.body;
  }
  body.innerHTML = '';
  body.append(pre);
}

function responseText() {
  const res = responses[cur.id || ''];
  if (!res || res.error) return '';
  const parsed = parseJSON(res);
  return parsed !== undefined && ui.pretty ? JSON.stringify(parsed, null, 2) : res.body;
}

const EXTENSIONS = {
  'application/json': 'json', 'application/xml': 'xml', 'text/xml': 'xml', 'text/html': 'html',
  'text/plain': 'txt', 'text/csv': 'csv', 'text/css': 'css', 'application/javascript': 'js',
  'text/javascript': 'js', 'application/yaml': 'yaml', 'application/x-yaml': 'yaml', 'application/pdf': 'pdf',
  'application/zip': 'zip', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg',
};

function responseFileName(res, type) {
  let base = cur.name.trim();
  if (!base) {
    try { base = decodeURIComponent(new URL(res.url).pathname.split('/').filter(Boolean).pop() || ''); } catch { /* ignore */ }
  }
  base = (base || 'response').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'response';
  if (/\.\w{1,5}$/.test(base)) return base;
  const ext = EXTENSIONS[type] || (/\+json$/.test(type) || parseJSON(res) !== undefined ? 'json'
    : /\+xml$/.test(type) ? 'xml' : res.encoding === 'base64' ? 'bin' : 'txt');
  return `${base}.${ext}`;
}

async function saveResponse() {
  const res = responses[cur.id || ''];
  if (!res || res.error || !res.body) return;
  const type = (res.contentType || '').split(';')[0].trim().toLowerCase() || 'text/plain';
  const data = res.encoding === 'base64'
    ? Uint8Array.from(atob(res.body), (c) => c.charCodeAt(0))
    : responseText();
  const blob = new Blob([data], { type });
  const name = responseFileName(res, type);

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      flash($('#save-body'), 'Saved');
    } catch (e) {
      if (e.name !== 'AbortError') toast(`Could not save the file: ${e.message}`);
    }
    return;
  }
  // Browsers without the file picker (Firefox, Safari): regular download.
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 4000);
}

// ── cURL ───────────────────────────────────────────────

function importCurl(text) {
  const { req, warnings } = parseCurl(text);
  stashCurrent();
  cur = { ...blankRequest(), ...req };
  cur.params = parseQuery(cur.url);
  delete responses[''];
  renderEditor();
  renderSidebar();
  persistSoon();
  if (warnings.length) toast(warnings.join(' '));
}

async function copyAsCurl() {
  try {
    await navigator.clipboard.writeText(toCurl(buildRequest()));
    flash($('#curl-copy'), 'Copied');
  } catch (e) {
    toast(e.message);
  }
}

function openCurlDialog() {
  $('#curl-text').value = '';
  $('#curl-error').hidden = true;
  $('#curl-dialog').showModal();
  $('#curl-text').focus();
}

function submitCurlDialog() {
  try {
    importCurl($('#curl-text').value);
    $('#curl-dialog').close();
  } catch (e) {
    $('#curl-error').textContent = e.message;
    $('#curl-error').hidden = false;
  }
}

// ── Environments dialog ────────────────────────────────

let editingEnv = null;

function renderEnvSelect() {
  const sel = $('#env-select');
  sel.innerHTML = '<option value="">No environment</option>' +
    state.envs.map((e) => `<option value="${esc(e.id)}">${esc(e.name || 'Unnamed')}</option>`).join('');
  sel.value = state.envs.some((e) => e.id === state.activeEnv) ? state.activeEnv : '';
}

function renderEnvDialog() {
  const items = $('#env-items');
  items.innerHTML = '';
  for (const env of state.envs) {
    const item = el('div', `item${env.id === editingEnv ? ' active' : ''}`, '<span class="label"></span>');
    $('.label', item).textContent = env.name || 'Unnamed';
    item.onclick = () => { editingEnv = env.id; renderEnvDialog(); };
    items.append(item);
  }
  const env = state.envs.find((e) => e.id === editingEnv);
  $('#env-empty').hidden = !!env;
  $('#env-form').hidden = !env;
  if (!env) return;
  $('#env-name').value = env.name;
  renderKV($('#env-vars'), env.vars, persistSoon, ['variable', 'value']);
  const del = $('#env-del');
  del.textContent = 'Delete';
  del.classList.remove('armed');
}

function openEnvDialog() {
  editingEnv = state.envs.some((e) => e.id === state.activeEnv) ? state.activeEnv : state.envs[0]?.id ?? null;
  renderEnvDialog();
  $('#env-dialog').showModal();
}

// ── Layout: draggable divider ──────────────────────────

function initDivider() {
  const divider = $('#divider');
  const split = $('#split');
  const pane = $('.req-pane');
  try {
    const saved = parseFloat(localStorage.getItem('rc.split'));
    if (saved > 0.15 && saved < 0.85) pane.style.flexBasis = `${saved * 100}%`;
  } catch { /* storage unavailable */ }

  divider.addEventListener('pointerdown', (e) => {
    divider.setPointerCapture(e.pointerId);
    divider.classList.add('dragging');
    const rect = split.getBoundingClientRect();
    const move = (ev) => {
      const frac = Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width));
      pane.style.flexBasis = `${frac * 100}%`;
    };
    const up = () => {
      divider.classList.remove('dragging');
      divider.removeEventListener('pointermove', move);
      try { localStorage.setItem('rc.split', parseFloat(pane.style.flexBasis) / 100); } catch { /* ignore */ }
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up, { once: true });
  });
}

// ── Wiring ─────────────────────────────────────────────

function bind() {
  $('#method').innerHTML = METHODS.map((m) => `<option value="${m}" class="m-${m}">${m}</option>`).join('');

  $('#req-name').oninput = (e) => { cur.name = e.target.value; changed(); };
  $('#method').onchange = (e) => { cur.method = e.target.value; setMethodClass(); changed(); };
  $('#url').oninput = (e) => { cur.url = e.target.value; syncParamsFromUrl(); changed(); };
  $('#req-bar').onsubmit = (e) => { e.preventDefault(); send(); };
  $('#save').onclick = saveRequest;
  $('#new-btn').onclick = newRequest;

  $$('#req-tabs > button').forEach((b) => {
    b.onclick = () => { ui.reqTab = b.dataset.tab; switchTab($('#req-tabs'), $('.req-pane .tab-body'), ui.reqTab); };
  });
  $$('#res-tabs > button').forEach((b) => {
    b.onclick = () => { ui.resTab = b.dataset.tab; switchTab($('#res-tabs'), $('.res-pane .tab-body'), ui.resTab); };
  });
  $$('.side-tabs > button').forEach((b) => {
    b.onclick = () => {
      ui.side = b.dataset.side;
      $$('.side-tabs > button').forEach((x) => x.classList.toggle('active', x === b));
      renderSidebar();
    };
  });
  $('#search').oninput = renderSidebar;
  $('#clear-history').onclick = () => { state.history = []; renderSidebar(); persistSoon(); };

  $$('input[name="body-type"]').forEach((r) => {
    r.onchange = () => { cur.bodyType = r.value; renderBodyType(); changed(); };
  });
  const bodyText = $('#body-text');
  bodyText.oninput = () => { cur.body = bodyText.value; changed(); };
  bodyText.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    document.execCommand('insertText', false, '  ');
  });
  $('#format-json').onclick = () => {
    try {
      bodyText.value = cur.body = JSON.stringify(JSON.parse(substitute(cur.body, {})), null, 2);
      changed();
    } catch {
      bodyText.classList.add('invalid');
      setTimeout(() => bodyText.classList.remove('invalid'), 900);
    }
  };

  $('#auth-type').onchange = (e) => { cur.auth.type = e.target.value; renderAuth(); changed(); };
  $('#auth-token').oninput = (e) => { cur.auth.token = e.target.value; changed(); };
  $('#auth-user').oninput = (e) => { cur.auth.user = e.target.value; changed(); };
  $('#auth-pass').oninput = (e) => { cur.auth.pass = e.target.value; changed(); };

  $('#pretty-toggle').onclick = () => { ui.pretty = !ui.pretty; renderResponse(); };
  $('#copy-body').onclick = async () => {
    try {
      await navigator.clipboard.writeText(responseText());
      flash($('#copy-body'), 'Copied');
    } catch {
      flash($('#copy-body'), 'Failed');
    }
  };

  $('#save-body').onclick = saveResponse;

  $('#curl-import').onclick = openCurlDialog;
  $('#curl-copy').onclick = copyAsCurl;
  $('#curl-cancel').onclick = () => $('#curl-dialog').close();
  $('#curl-ok').onclick = submitCurlDialog;
  $('#curl-text').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submitCurlDialog(); }
  });
  $('#url').addEventListener('paste', (e) => {
    const text = e.clipboardData.getData('text');
    if (!/^\s*curl(\.exe)?\s/i.test(text)) return;
    e.preventDefault();
    try { importCurl(text); } catch (err) { toast(err.message); }
  });

  $('#env-select').onchange = (e) => { state.activeEnv = e.target.value || null; persistSoon(); };
  $('#env-edit').onclick = openEnvDialog;
  $('#env-close').onclick = () => $('#env-dialog').close();
  $('#env-dialog').addEventListener('close', renderEnvSelect);
  $('#env-add').onclick = () => {
    const env = { id: uid(), name: `Environment ${state.envs.length + 1}`, vars: [] };
    state.envs.push(env);
    if (!state.activeEnv) state.activeEnv = env.id;
    editingEnv = env.id;
    renderEnvDialog();
    persistSoon();
    $('#env-name').select();
  };
  $('#env-name').oninput = (e) => {
    const env = state.envs.find((x) => x.id === editingEnv);
    env.name = e.target.value;
    $('#env-items .item.active .label').textContent = env.name || 'Unnamed';
    persistSoon();
  };
  $('#env-del').onclick = (e) => {
    const btn = e.currentTarget;
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = 'Click again to delete';
      return;
    }
    state.envs = state.envs.filter((x) => x.id !== editingEnv);
    if (state.activeEnv === editingEnv) state.activeEnv = null;
    editingEnv = state.envs[0]?.id ?? null;
    renderEnvDialog();
    persistSoon();
  };

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (document.querySelector('dialog[open]')) return;
    if (mod && e.key === 'Enter') { e.preventDefault(); send(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveRequest(); }
  });
  window.addEventListener('beforeunload', () => { stashCurrent(); persist(true); });

  // Keep "5m ago" labels in the history list fresh.
  setInterval(() => { if (ui.side === 'history') renderSidebar(); }, 60_000);

  initDivider();
}

async function init() {
  bind();
  try {
    const r = await api('/api/state');
    const loaded = await r.json();
    state = { ...state, ...loaded };
    state.drafts ||= {};
  } catch { /* start fresh */ }
  if (state.draft) cur = { ...blankRequest(), ...state.draft };
  renderEnvSelect();
  renderEditor();
  renderSidebar();
}

init();
