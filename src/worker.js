/**
 * Edge Drop — Cloudflare Worker
 *
 * API（需登录）：
 *   POST   /api/login        { password }         登录，设置会话 Cookie（连续失败自动限流锁定）
 *   POST   /api/logout                            退出登录
 *   GET    /api/me                                登录状态
 *   GET    /api/items                             全部条目（按时间倒序，含过期时间与分享状态）
 *   POST   /api/notes        { text, ttl? }       新建笔记；ttl（秒）为临时笔记的有效期
 *   GET    /api/note/:id                          笔记全文
 *   POST   /api/files        原始字节流            上传文件（文件名在 X-File-Name 头，有效期在 X-Expires-In 头）
 *   GET    /api/file/:id     ?dl=1 为下载          读取文件（图片可直接内联预览）
 *   DELETE /api/item/:key    file:xx / note:xx    删除条目
 *   POST   /api/share        { key, ttl }         为条目生成临时分享链接
 *   DELETE /api/share/:token                      撤销分享
 *
 * 公开（免登录）：
 *   GET    /s/:token                              分享页面（静态 share.html）
 *   GET    /api/share/:token                      分享内容元信息（笔记含全文）
 *   GET    /api/share/:token/file  ?dl=1 为下载   分享的文件字节流
 *
 * KV key 约定：
 *   note:<id> / file:<id>   条目，metadata.kind 标记类型，metadata.expires 为临时条目到期时间戳
 *   share:<token>           分享记录，metadata { target, expires }，value 为同样内容的 JSON
 *   rl:login:<ip>           登录限流计数
 */

// KV 单值硬上限 25MiB，留余量限制单文件 20MB
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_NOTE_CHARS = 20000;
const PREVIEW_CHARS = 120;
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 天
const COOKIE_NAME = 'drop_session';
// 登录限流：连续失败 LOGIN_MAX_FAILS 次后按 2^n 分钟锁定，封顶 LOGIN_MAX_LOCK_MIN 分钟
const LOGIN_MAX_FAILS = 5;
const LOGIN_MAX_LOCK_MIN = 60;
const LOGIN_THROTTLE_TTL = 60 * 60; // 计数 key 的 TTL（秒）
// 临时条目 / 分享链接允许的有效期（秒），与前端选项一致
const TTL_OPTIONS = new Set([10 * 60, 60 * 60, 24 * 60 * 60, 7 * 24 * 60 * 60]);
// KV expirationTtl 的最小值
const KV_MIN_TTL = 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        console.error(err);
        return json({ error: '服务器内部错误' }, 500);
      }
    }
    // 分享页：/s/<token> 统一交给静态 share.html，token 由页面脚本从路径读取。
    // 静态资源默认把 /share.html 307 到 /share，所以这里直接请求无后缀路径避免重定向丢掉 token
    if (/^\/s\/[\w-]+$/.test(url.pathname)) {
      const shareUrl = new URL('/share', url);
      return env.ASSETS.fetch(new Request(shareUrl, request));
    }
    // 其余路径交给静态资源
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  // 无需登录的接口
  if (pathname === '/api/login' && method === 'POST') return login(request, env, url);
  if (pathname === '/api/logout' && method === 'POST') return logout(url);
  if (pathname === '/api/me' && method === 'GET') {
    return json({ required: !!env.DROP_PASSWORD, authed: await isAuthed(request, env) });
  }

  let m = pathname.match(/^\/api\/share\/([\w-]+)(\/file)?$/);
  if (m && method === 'GET') {
    return m[2] ? getShareFile(env, m[1], url) : getShare(env, m[1]);
  }

  // 以下接口均需登录
  if (!(await isAuthed(request, env))) return json({ error: '未登录' }, 401);

  if (pathname === '/api/items' && method === 'GET') return listItems(env);
  if (pathname === '/api/notes' && method === 'POST') return createNote(request, env);
  if (pathname === '/api/files' && method === 'POST') return uploadFile(request, env);
  if (pathname === '/api/share' && method === 'POST') return createShare(request, env, url);

  m = pathname.match(/^\/api\/file\/([\w-]+)$/);
  if (m && method === 'GET') return fileResponse(env, `file:${m[1]}`, url);

  m = pathname.match(/^\/api\/note\/([\w-]+)$/);
  if (m && method === 'GET') return getNote(env, m[1]);

  m = pathname.match(/^\/api\/item\/(file|note):([\w-]+)$/);
  if (m && method === 'DELETE') return deleteItem(env, `${m[1]}:${m[2]}`);

  m = pathname.match(/^\/api\/share\/([\w-]+)$/);
  if (m && method === 'DELETE') return deleteShare(env, m[1]);

  return json({ error: '接口不存在' }, 404);
}

// ---------- 条目 ----------

async function listItems(env) {
  const now = Date.now();
  const items = [];
  const shares = new Map(); // target key -> { token, expires }
  let cursor;
  do {
    const page = await env.DROP.list({ cursor });
    for (const key of page.keys) {
      const md = key.metadata || {};
      // 分享记录：同一次遍历里顺带收集，避免额外 list 调用
      if (key.name.startsWith('share:')) {
        if (!md.target || (md.expires && md.expires <= now)) continue;
        const prev = shares.get(md.target);
        if (!prev || (md.expires || Infinity) > (prev.expires || Infinity)) {
          shares.set(md.target, { token: key.name.slice(6), expires: md.expires });
        }
        continue;
      }
      if (!md.kind) continue; // 跳过非本应用的 key
      if (md.expires && md.expires <= now) continue; // KV 过期删除有延迟，前端不显示已到期条目
      items.push({
        id: key.name,
        kind: md.kind,
        name: md.name,
        type: md.type,
        size: md.size,
        created: md.created,
        expires: md.expires,
        preview: md.preview,
        truncated: md.truncated === true,
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  for (const item of items) item.share = shares.get(item.id) || null;
  items.sort((a, b) => (b.created || 0) - (a.created || 0));
  const totalSize = items.reduce((sum, it) => sum + (it.size || 0), 0);
  return json({ items, totalSize });
}

async function createNote(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: '请求格式错误' }, 400);
  const text = String(body.text ?? '').trim();
  if (!text) return json({ error: '内容不能为空' }, 400);
  if (text.length > MAX_NOTE_CHARS) return json({ error: `笔记最长 ${MAX_NOTE_CHARS} 字` }, 413);
  const ttl = parseTtl(body.ttl);
  if (ttl === null) return json({ error: '有效期不合法' }, 400);

  const id = `note:${genId()}`;
  const created = Date.now();
  const item = {
    id,
    kind: 'note',
    size: new TextEncoder().encode(text).length,
    created,
    expires: ttl ? created + ttl * 1000 : undefined,
    preview: text.slice(0, PREVIEW_CHARS),
    truncated: text.length > PREVIEW_CHARS,
    share: null,
  };
  await env.DROP.put(id, text, {
    ...(ttl ? { expirationTtl: ttl } : {}),
    metadata: {
      kind: 'note',
      size: item.size,
      created,
      expires: item.expires,
      preview: item.preview,
      truncated: item.truncated,
    },
  });
  return json({ ok: true, item });
}

async function getNote(env, id) {
  const text = await env.DROP.get(`note:${id}`, 'text');
  if (text === null) return json({ error: '笔记不存在' }, 404);
  return json({ id: `note:${id}`, text });
}

async function uploadFile(request, env) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_FILE_SIZE) return json({ error: '单个文件不能超过 20MB' }, 413);
  const ttl = parseTtl(request.headers.get('x-expires-in'));
  if (ttl === null) return json({ error: '有效期不合法' }, 400);

  let name = '未命名文件';
  try {
    name = decodeURIComponent(request.headers.get('x-file-name') || '') || name;
  } catch { /* 文件名头非法时用默认名 */ }
  const type = request.headers.get('content-type') || 'application/octet-stream';

  const data = await request.arrayBuffer();
  if (!data.byteLength) return json({ error: '文件为空' }, 400);
  if (data.byteLength > MAX_FILE_SIZE) return json({ error: '单个文件不能超过 20MB' }, 413);

  const id = `file:${genId()}`;
  const created = Date.now();
  const item = {
    id,
    kind: 'file',
    name,
    type,
    size: data.byteLength,
    created,
    expires: ttl ? created + ttl * 1000 : undefined,
    share: null,
  };
  await env.DROP.put(id, data, {
    ...(ttl ? { expirationTtl: ttl } : {}),
    metadata: { kind: 'file', name, type, size: data.byteLength, created, expires: item.expires },
  });
  return json({ ok: true, item });
}

// 读取 file:<id> 并按浏览器可直接使用的方式返回；登录访问与分享访问共用
async function fileResponse(env, key, url) {
  const { value, metadata } = await env.DROP.getWithMetadata(key, 'arrayBuffer');
  if (value === null) return json({ error: '文件不存在' }, 404);
  const md = metadata || {};
  const disposition = url.searchParams.get('dl') === '1' ? 'attachment' : 'inline';
  const headers = new Headers({
    'Content-Type': md.type || 'application/octet-stream',
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(md.name || 'file')}`,
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  });
  return new Response(value, { headers });
}

async function deleteItem(env, key) {
  await env.DROP.delete(key);
  return json({ ok: true });
}

// ---------- 分享 ----------

async function createShare(request, env, url) {
  const body = await readJson(request);
  if (!body) return json({ error: '请求格式错误' }, 400);
  const target = String(body.key ?? '');
  if (!/^(file|note):[\w-]+$/.test(target)) return json({ error: '条目不合法' }, 400);
  let ttl = parseTtl(body.ttl);
  if (!ttl) return json({ error: '请选择分享有效期' }, 400);

  // 用带前缀的 list 查条目是否存在：只取 metadata，不用把整个文件读出来
  const found = await env.DROP.list({ prefix: target, limit: 1 });
  const entry = found.keys.find((k) => k.name === target);
  if (!entry || !entry.metadata?.kind) return json({ error: '条目不存在' }, 404);

  // 分享不能活得比临时条目本身更久
  const now = Date.now();
  const itemExpires = entry.metadata.expires;
  if (itemExpires) {
    const remain = Math.floor((itemExpires - now) / 1000);
    if (remain < KV_MIN_TTL) return json({ error: '条目即将过期，无法分享' }, 400);
    ttl = Math.min(ttl, remain);
  }

  const token = genToken();
  const share = { target, expires: now + ttl * 1000 };
  await env.DROP.put(`share:${token}`, JSON.stringify(share), {
    expirationTtl: ttl,
    metadata: share,
  });
  return json({ ok: true, share: { token, expires: share.expires, url: shareUrl(url, token) } });
}

async function deleteShare(env, token) {
  await env.DROP.delete(`share:${token}`);
  return json({ ok: true });
}

// 解析分享记录，顺带过滤掉 KV 尚未清理的已到期记录
async function resolveShare(env, token) {
  const share = await env.DROP.get(`share:${token}`, 'json').catch(() => null);
  if (!share || !share.target) return null;
  if (share.expires && share.expires <= Date.now()) return null;
  return share;
}

async function getShare(env, token) {
  const share = await resolveShare(env, token);
  if (!share) return json({ error: '分享不存在或已过期' }, 404, NO_STORE);

  if (share.target.startsWith('note:')) {
    const text = await env.DROP.get(share.target, 'text');
    if (text === null) return json({ error: '内容已被删除' }, 404, NO_STORE);
    return json({ kind: 'note', text, expires: share.expires }, 200, NO_STORE);
  }

  const found = await env.DROP.list({ prefix: share.target, limit: 1 });
  const entry = found.keys.find((k) => k.name === share.target);
  if (!entry) return json({ error: '内容已被删除' }, 404, NO_STORE);
  const md = entry.metadata || {};
  return json(
    { kind: 'file', name: md.name, type: md.type, size: md.size, expires: share.expires },
    200,
    NO_STORE,
  );
}

async function getShareFile(env, token, url) {
  const share = await resolveShare(env, token);
  if (!share || !share.target.startsWith('file:')) {
    return json({ error: '分享不存在或已过期' }, 404, NO_STORE);
  }
  return fileResponse(env, share.target, url);
}

const NO_STORE = { 'Cache-Control': 'no-store' };

function shareUrl(url, token) {
  return `${url.origin}/s/${token}`;
}

// ---------- 认证 ----------

async function login(request, env, url) {
  if (!env.DROP_PASSWORD) return json({ ok: true, required: false });

  // 限流：按客户端 IP 计数，锁定期间直接拒绝
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rl = await getLoginThrottle(env, ip);
  if (rl.lockedUntil > Date.now()) {
    const waitSec = Math.ceil((rl.lockedUntil - Date.now()) / 1000);
    return json({ error: `尝试过于频繁，请约 ${Math.ceil(waitSec / 60)} 分钟后再试` }, 429, {
      'Retry-After': String(waitSec),
    });
  }

  const body = await readJson(request);
  if (!body || !(await safeEqual(String(body.password ?? ''), env.DROP_PASSWORD))) {
    await recordLoginFail(env, ip, rl);
    return json({ error: '密码错误' }, 401);
  }

  if (rl.fails) await env.DROP.delete(throttleKey(ip)); // 登录成功后清零计数
  const token = await makeToken(env);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, url, SESSION_MAX_AGE) });
}

// ---------- 登录限流 ----------

function throttleKey(ip) {
  return `rl:login:${ip}`;
}

async function getLoginThrottle(env, ip) {
  try {
    return (await env.DROP.get(throttleKey(ip), 'json')) || { fails: 0 };
  } catch {
    return { fails: 0 };
  }
}

async function recordLoginFail(env, ip, rl) {
  rl.fails += 1;
  if (rl.fails >= LOGIN_MAX_FAILS) {
    const minutes = Math.min(2 ** (rl.fails - LOGIN_MAX_FAILS), LOGIN_MAX_LOCK_MIN);
    rl.lockedUntil = Date.now() + minutes * 60 * 1000;
  }
  await env.DROP.put(throttleKey(ip), JSON.stringify(rl), { expirationTtl: LOGIN_THROTTLE_TTL });
}

function logout(url) {
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', url, 0) });
}

async function isAuthed(request, env) {
  if (!env.DROP_PASSWORD) return true; // 未设置密码则放行（本地开发便利）
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  const expNum = Number(exp);
  if (!expNum || expNum * 1000 < Date.now() || !/^[0-9a-f]{64}$/.test(sig || '')) return false;
  const key = await sessionKey(env);
  return crypto.subtle.verify('HMAC', key, hexToBuf(sig), new TextEncoder().encode(exp));
}

async function makeToken(env) {
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_MAX_AGE);
  const key = await sessionKey(env);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(exp));
  return `${exp}.${bufToHex(sig)}`;
}

// 会话密钥由密码派生：改密码后所有旧会话自动失效
async function sessionKey(env) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${env.DROP_PASSWORD}::edge-drop-session`),
  );
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return bufToHex(ha) === bufToHex(hb);
}

function sessionCookie(value, url, maxAge) {
  const parts = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (url.protocol === 'https:') parts.push('Secure');
  return parts.join('; ');
}

// ---------- 工具 ----------

// 条目内部 id：只需唯一，不承担安全职责
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 分享 token 是公开可访问的凭证，必须不可猜测：128 位 CSPRNG
function genToken() {
  return bufToHex(crypto.getRandomValues(new Uint8Array(16)));
}

// 有效期解析：空 / 0 → 0（永久）；合法选项 → 秒数；其他 → null（非法）
function parseTtl(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === 0 || raw === '0') return 0;
  const n = Number(raw);
  return TTL_OPTIONS.has(n) ? n : null;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}
