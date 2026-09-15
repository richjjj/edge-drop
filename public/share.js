'use strict';

// 分享页：/s/<token>，免登录；只读展示一条笔记或一个文件

const { formatSize, untilTime } = window.dropFmt;

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
};

const token = location.pathname.split('/').pop();
const fileUrl = `/api/share/${token}/file`;

window.addEventListener('DOMContentLoaded', boot);

async function boot() {
  const main = $('#share-main');
  let data;
  try {
    const res = await fetch(`/api/share/${token}`, { cache: 'no-store' });
    data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `打开失败 (${res.status})`);
  } catch (e) {
    main.replaceChildren(emptyState(e.message));
    $('#share-status').textContent = '';
    return;
  }
  main.replaceChildren(data.kind === 'note' ? noteCard(data) : fileCard(data));
  $('#share-status').textContent = `${untilTime(data.expires)}后失效`;
}

function emptyState(msg) {
  const wrap = el('div', 'empty');
  const icon = el('div', 'empty-icon');
  icon.textContent = '❦';
  const p = el('p');
  p.textContent = msg || '分享不存在或已过期';
  const sub = el('p', 'empty-sub');
  sub.textContent = '临时分享到期后会自动失效';
  wrap.append(icon, p, sub);
  return wrap;
}

function noteCard(data) {
  const card = el('article', 'card');
  const body = el('div', 'card-body');
  const text = el('div', 'note-text');
  text.textContent = data.text;
  body.appendChild(text);

  const meta = el('div', 'card-meta');
  const left = el('span');
  left.textContent = formatSize(new TextEncoder().encode(data.text).length);
  const actions = el('span', 'actions always');
  const copy = el('button', 'act');
  copy.textContent = '复制';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(data.text);
      toast('已复制');
    } catch {
      toast('复制失败，请手动选择文本');
    }
  });
  actions.appendChild(copy);
  meta.append(left, actions);
  card.append(body, meta);
  return card;
}

function fileCard(data) {
  const card = el('article', 'card');
  const body = el('div', 'card-body');
  if ((data.type || '').startsWith('image/')) {
    const link = el('a', 'img-wrap');
    link.href = fileUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    const img = document.createElement('img');
    img.src = fileUrl;
    img.alt = data.name || '';
    link.appendChild(img);
    body.appendChild(link);
    const name = el('div', 'file-name');
    name.textContent = data.name || '';
    name.style.marginTop = '8px';
    body.appendChild(name);
  } else {
    const row = el('div', 'file-row');
    const hasExt = (data.name || '').includes('.');
    const badge = el('span', 'ext-badge');
    badge.textContent = hasExt ? data.name.split('.').pop().toUpperCase().slice(0, 5) : 'FILE';
    const info = el('div');
    const name = el('div', 'file-name');
    name.textContent = data.name || '文件';
    const sub = el('div', 'card-meta');
    sub.textContent = data.type || '未知类型';
    info.append(name, sub);
    row.append(badge, info);
    body.appendChild(row);
  }

  const meta = el('div', 'card-meta');
  const left = el('span');
  left.textContent = formatSize(data.size);
  const actions = el('span', 'actions always');
  const open = el('a', 'act');
  open.href = fileUrl;
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = '打开';
  const dl = el('a', 'act');
  dl.href = `${fileUrl}?dl=1`;
  dl.textContent = '下载';
  actions.append(open, dl);
  meta.append(left, actions);
  card.append(body, meta);
  return card;
}

let toastTimer;
function toast(msg, ms = 2200) {
  const node = $('#toast');
  node.textContent = msg;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), ms);
}
