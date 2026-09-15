'use strict';

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 与后端保持一致
const OVERRIDE_MS = 60 * 1000; // KV 最终一致性窗口：本地变更覆盖服务端列表的时长
const { formatSize, relTime, untilTime, ttlLabel } = window.dropFmt;

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
};

// KV 是最终一致性存储：刚写入/删除/分享的条目先本地维护，等列表同步
const state = {
  items: new Map(), // 服务端已确认的条目
  pending: new Map(), // 刚写入、等待列表同步
  deleted: new Set(), // 刚删除、防止旧列表里复现
  shares: new Map(), // 刚分享/撤销：id -> { share, at }，防止旧列表把分享状态改回去
};

window.addEventListener('DOMContentLoaded', boot);

// ---------- 初始化 ----------

async function boot() {
  bindEvents();
  try {
    const me = await fetch('/api/me').then((r) => r.json());
    if (me.required && !me.authed) {
      showLogin();
    } else {
      showApp();
    }
  } catch {
    toast('无法连接服务器');
  }
}

function bindEvents() {
  $('#login-form').addEventListener('submit', onLogin);
  $('#btn-logout').addEventListener('click', onLogout);
  $('#btn-send').addEventListener('click', sendNote);
  bindThemeMenu();
  bindShareDialog();
  $('#note-input').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      sendNote();
    }
  });
  const ttlSelect = $('#ttl-select');
  ttlSelect.addEventListener('change', () => {
    ttlSelect.classList.toggle('active', currentTtl() > 0);
  });

  // 拖拽（pointer-events:none 的遮罩不会干扰 dragleave 计数）
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('#drop-overlay').hidden = false;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (--dragDepth <= 0) {
      dragDepth = 0;
      $('#drop-overlay').hidden = true;
    }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) {
      files.forEach(uploadFile);
    } else {
      const text = e.dataTransfer?.getData('text/plain');
      if (text?.trim()) createNote(text.trim());
    }
  });

  // 粘贴截图/图片
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      files.forEach(uploadFile);
    }
  });

  // 相对时间与到期倒计时每分钟刷新一次
  setInterval(() => {
    if (!$('#app-view').hidden) render();
  }, 60 * 1000);
}

// 输入区选择的有效期（秒），0 为永久
function currentTtl() {
  return Number($('#ttl-select').value) || 0;
}

// ---------- 主题切换 ----------

function bindThemeMenu() {
  const menu = $('#theme-menu');

  // 根据 localStorage 同步单选框状态
  const theme = localStorage.getItem('drop-theme') || 'paper';
  const mode = localStorage.getItem('drop-mode') || 'auto';
  const themeRadio = menu.querySelector(`input[name="theme"][value="${theme}"]`);
  const modeRadio = menu.querySelector(`input[name="mode"][value="${mode}"]`);
  if (themeRadio) themeRadio.checked = true;
  if (modeRadio) modeRadio.checked = true;

  menu.addEventListener('change', (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.name === 'theme') localStorage.setItem('drop-theme', input.value);
    if (input.name === 'mode') localStorage.setItem('drop-mode', input.value);
    window.dropThemeCtl?.apply();
  });

  // 点击菜单外 / Esc 关闭
  document.addEventListener('click', (e) => {
    if (menu.open && !menu.contains(e.target)) menu.removeAttribute('open');
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      menu.removeAttribute('open');
      menu.querySelector('summary').focus();
    }
  });
}

function showLogin() {
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  setTimeout(() => $('#login-password').focus(), 50);
}

function showApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  loadItems();
}

// ---------- API ----------

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (res.status === 401) {
    showLogin();
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

async function onLogin(e) {
  e.preventDefault();
  $('#login-error').textContent = '';
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('#login-password').value }),
  });
  if (res.ok) {
    $('#login-password').value = '';
    showApp();
  } else {
    const data = await res.json().catch(() => ({}));
    $('#login-error').textContent = data.error || '登录失败';
  }
}

async function onLogout() {
  await fetch('/api/logout', { method: 'POST' });
  showLogin();
}

// ---------- 条目操作 ----------

async function loadItems() {
  try {
    const data = await api('/api/items');
    state.items = new Map();
    for (const item of data.items) {
      if (state.deleted.has(item.id)) continue;
      state.items.set(item.id, item);
      state.pending.delete(item.id); // 列表里出现了，说明已同步
    }
    applyShareOverrides();
    render();
  } catch (e) {
    if (e.message !== 'unauthorized') toast(e.message);
  }
}

// 刚分享/撤销的状态在一致性窗口内以本地为准
function applyShareOverrides() {
  const now = Date.now();
  for (const [id, ov] of state.shares) {
    if (now - ov.at > OVERRIDE_MS) {
      state.shares.delete(id);
      continue;
    }
    const item = state.items.get(id) || state.pending.get(id);
    if (item) item.share = ov.share;
  }
}

async function sendNote() {
  const input = $('#note-input');
  const text = input.value.trim();
  if (!text) return;
  await createNote(text, () => {
    input.value = '';
    input.focus();
  });
}

async function createNote(text, onDone) {
  const btn = $('#btn-send');
  btn.disabled = true;
  const ttl = currentTtl();
  try {
    const data = await api('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ttl }),
    });
    state.pending.set(data.item.id, data.item);
    render();
    loadItems();
    onDone?.();
    toast(ttl ? `已保存，${ttlLabel(ttl)}后自动删除` : '已保存');
  } catch (e) {
    if (e.message !== 'unauthorized') toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function uploadFile(file) {
  if (file.size > MAX_FILE_SIZE) {
    toast(`「${file.name || '文件'}」超过 20MB 限制`);
    return;
  }
  const name = file.name || `粘贴的图片.${(file.type.split('/')[1] || 'png').split(';')[0]}`;
  const ttl = currentTtl();
  toast(`正在上传 ${name} …`, 1500);
  try {
    const data = await api('/api/files', {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(name),
        'X-Expires-In': String(ttl),
      },
      body: file,
    });
    state.pending.set(data.item.id, data.item);
    render();
    loadItems();
    toast(ttl ? `已上传 ${name}，${ttlLabel(ttl)}后自动删除` : `已上传 ${name}`);
  } catch (e) {
    if (e.message !== 'unauthorized') toast(e.message);
  }
}

async function removeItem(id) {
  state.deleted.add(id);
  state.items.delete(id);
  state.pending.delete(id);
  render();
  try {
    await api(`/api/item/${id}`, { method: 'DELETE' });
    toast('已删除');
  } catch (e) {
    state.deleted.delete(id);
    if (e.message !== 'unauthorized') toast(e.message);
    loadItems();
  }
  setTimeout(() => state.deleted.delete(id), OVERRIDE_MS);
}

async function copyNote(item) {
  try {
    let text = item.preview;
    if (item.truncated) {
      const data = await api(`/api/note/${item.id.slice(5)}`);
      text = data.text;
    }
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch (e) {
    if (e.message !== 'unauthorized') toast(e.message);
  }
}

async function expandNote(item, textNode, btnNode) {
  try {
    const data = await api(`/api/note/${item.id.slice(5)}`);
    textNode.textContent = data.text;
    btnNode.remove();
  } catch (e) {
    if (e.message !== 'unauthorized') toast(e.message);
  }
}

// ---------- 临时分享 ----------

let shareTarget = null; // 正在对话框里操作的条目

function bindShareDialog() {
  const dlg = $('#share-dialog');
  dlg.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (target === dlg) return dlg.close(); // 点击遮罩关闭
    if (target.hasAttribute('data-close')) return dlg.close();
    const opt = target.closest('[data-ttl]');
    if (opt) createShare(Number(opt.dataset.ttl));
  });
  dlg.addEventListener('close', () => {
    shareTarget = null;
  });
  $('#btn-copy-link').addEventListener('click', () => copyText($('#share-link').value));
}

function openShareDialog(item) {
  shareTarget = item;
  const dlg = $('#share-dialog');
  dlg.querySelector('.share-pick').hidden = false;
  dlg.querySelector('.share-result').hidden = true;
  dlg.showModal();
}

async function createShare(ttl) {
  const item = shareTarget;
  if (!item) return;
  try {
    const data = await api('/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: item.id, ttl }),
    });
    setShare(item.id, { token: data.share.token, expires: data.share.expires });
    showShareResult(data.share);
  } catch (e) {
    if (e.message !== 'unauthorized') toast(e.message);
  }
}

function showShareResult(share) {
  const dlg = $('#share-dialog');
  $('#share-link').value = share.url;
  $('#share-expire').textContent = `${untilTime(share.expires)}后失效，可随时撤销。`;
  dlg.querySelector('.share-pick').hidden = true;
  dlg.querySelector('.share-result').hidden = false;
  copyText(share.url, '链接已复制');
}

async function revokeShare(item) {
  const prev = item.share;
  if (!prev?.token) return;
  setShare(item.id, null);
  try {
    await api(`/api/share/${prev.token}`, { method: 'DELETE' });
    toast('已撤销，链接将在一分钟内失效');
  } catch (e) {
    setShare(item.id, prev);
    if (e.message !== 'unauthorized') toast(e.message);
  }
}

// 本地立刻更新分享状态，并记录覆盖以对抗列表延迟
function setShare(id, share) {
  state.shares.set(id, { share, at: Date.now() });
  const item = state.items.get(id) || state.pending.get(id);
  if (item) item.share = share;
  render();
}

function shareLink(item) {
  return `${location.origin}/s/${item.share.token}`;
}

async function copyText(text, okMsg = '已复制') {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    toast('复制失败，请手动复制');
  }
}

// ---------- 渲染 ----------

function mergedItems() {
  const now = Date.now();
  const map = new Map([...state.items, ...state.pending]);
  return [...map.values()]
    .filter((item) => !state.deleted.has(item.id))
    .filter((item) => !item.expires || item.expires > now) // 到期条目本地先隐藏，KV 稍后清理
    .sort((a, b) => (b.created || 0) - (a.created || 0));
}

function render() {
  const wrap = $('#items');
  wrap.innerHTML = '';
  const list = mergedItems();
  $('#empty').hidden = list.length > 0;
  let total = 0;
  for (const item of list) {
    total += item.size || 0;
    wrap.appendChild(renderItem(item));
  }
  const stat = $('#stat-line');
  stat.textContent = '';
  if (list.length) {
    const count = el('span', 'stat-count');
    count.textContent = `${list.length} 个项目`;
    const size = el('span', 'stat-size');
    size.textContent = formatSize(total);
    stat.append(count, size);
  }
}

function renderItem(item) {
  const card = el('article', 'card');
  const body = el('div', 'card-body');
  if (item.kind === 'note') {
    buildNoteBody(item, body);
  } else {
    buildFileBody(item, body);
  }
  card.appendChild(body);
  card.appendChild(buildMeta(item));
  return card;
}

function buildNoteBody(item, body) {
  const text = el('div', 'note-text');
  text.textContent = item.preview + (item.truncated ? ' …' : '');
  body.appendChild(text);
  if (item.truncated) {
    const more = el('button', 'link-btn');
    more.textContent = '展开全文';
    more.addEventListener('click', () => expandNote(item, text, more));
    body.appendChild(more);
  }
}

function buildFileBody(item, body) {
  const fileUrl = `/api/file/${item.id.slice(5)}`;
  if ((item.type || '').startsWith('image/')) {
    const link = el('a', 'img-wrap');
    link.href = fileUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = fileUrl;
    img.alt = item.name || '';
    link.appendChild(img);
    body.appendChild(link);
    const name = el('div', 'file-name');
    name.textContent = item.name || '';
    name.style.marginTop = '8px';
    body.appendChild(name);
  } else {
    const row = el('div', 'file-row');
    const hasExt = (item.name || '').includes('.');
    const badge = el('span', 'ext-badge');
    badge.textContent = hasExt ? item.name.split('.').pop().toUpperCase().slice(0, 5) : 'FILE';
    const info = el('div');
    const name = el('div', 'file-name');
    name.textContent = item.name || '文件';
    const sub = el('div');
    sub.className = 'card-meta';
    sub.textContent = item.type || '未知类型';
    info.appendChild(name);
    info.appendChild(sub);
    row.appendChild(badge);
    row.appendChild(info);
    body.appendChild(row);
  }
}

function buildMeta(item) {
  const meta = el('div', 'card-meta');
  const left = el('span');
  left.textContent = `${formatSize(item.size)} · ${relTime(item.created)}`;
  if (item.expires) {
    const tag = el('span', 'expire-tag');
    tag.textContent = `${untilTime(item.expires)}后删除`;
    left.append(' · ', tag);
  }
  if (item.share) {
    const tag = el('span', 'share-tag');
    tag.textContent = `分享中 · ${untilTime(item.share.expires)}后失效`;
    left.append(' · ', tag);
  }
  const actions = el('span', 'actions');

  if (item.kind === 'note') {
    actions.appendChild(actionBtn('复制', '', () => copyNote(item)));
  } else {
    const fileUrl = `/api/file/${item.id.slice(5)}`;
    const open = el('a', 'act');
    open.href = fileUrl;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = '打开';
    const dl = el('a', 'act');
    dl.href = `${fileUrl}?dl=1`;
    dl.textContent = '下载';
    actions.appendChild(open);
    actions.appendChild(dl);
  }
  if (item.share) {
    actions.appendChild(actionBtn('复制链接', '', () => copyText(shareLink(item), '链接已复制')));
    actions.appendChild(actionBtn('撤销分享', 'danger', () => revokeShare(item)));
  } else {
    actions.appendChild(actionBtn('分享', '', () => openShareDialog(item)));
  }
  actions.appendChild(actionBtn('删除', 'danger', () => removeItem(item.id)));

  meta.appendChild(left);
  meta.appendChild(actions);
  return meta;
}

function actionBtn(label, cls, fn) {
  const btn = el('button', `act ${cls}`);
  btn.textContent = label;
  btn.addEventListener('click', fn);
  return btn;
}

// ---------- 工具 ----------

let toastTimer;
function toast(msg, ms = 2200) {
  const node = $('#toast');
  node.textContent = msg;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), ms);
}
