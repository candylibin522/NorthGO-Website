import { createHash, randomBytes } from 'node:crypto';
import { verifyPassword, passwordHash, passwordIsValid } from '../backend/passwords.mjs';
import { enquiryFieldLimits, normalizedEnquiry } from '../backend/enquiry-validation.mjs';

const states = ['new', 'processing', 'replied', 'archived'];
const noManagement = {
  revision: 0, state: 'new', assignee: '', notes: '', corrections: {},
  updatedAt: null, updatedBy: null, deletedAt: null
};

const hash = token => createHash('sha256').update(token).digest('hex');
const query = (env, sql, ...values) => env.DB.prepare(sql).bind(...values);

function json(value, status = 200, headers = {}) {
  return Response.json(value, {
    status, headers: { 'Cache-Control': 'no-store', ...headers }
  });
}

async function inputFor(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const parts = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > 24000) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function sameOrigin(request) {
  return request.headers.get('Origin') === new URL(request.url).origin;
}

async function takeLimit(env, request, name, limit, duration) {
  const key = hash(name + ':' + (request.headers.get('CF-Connecting-IP') || 'local'));
  const now = Date.now();
  const result = await query(env, `
    INSERT INTO rate_limits VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
    attempts=CASE WHEN rate_limits.expires <= ? THEN 1 ELSE rate_limits.attempts+1 END,
    expires=CASE WHEN rate_limits.expires <= ? THEN excluded.expires ELSE rate_limits.expires END
    RETURNING attempts
  `, key, now + duration, now, now).first();
  return result.attempts <= limit;
}

function sessionCookie(request, token, maxAge = 28800) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return 'northgo_session=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + secure;
}

async function getSession(env, request) {
  const token = (request.headers.get('Cookie') || '').split(';').map(value => value.trim())
    .find(value => value.startsWith('northgo_session='))?.slice(16);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return query(env, 'SELECT * FROM sessions WHERE token_hash=? AND expires>?', hash(token), Date.now()).first();
}

async function management(env, reference) {
  const row = await query(env, 'SELECT * FROM enquiries WHERE reference=?', reference).first();
  return row ? {
    revision: row.revision, state: row.state, assignee: row.assignee, notes: row.notes,
    corrections: JSON.parse(row.corrections), updatedAt: row.updated_at,
    updatedBy: row.updated_by, deletedAt: row.deleted_at
  } : { ...noManagement, corrections: {} };
}

async function saveManagement(env, reference, value, actor) {
  const previous = await management(env, reference);
  if (previous.revision !== value.revision) return false;
  const after = {
    ...value, revision: value.revision + 1, updatedAt: new Date().toISOString(),
    updatedBy: actor, deletedAt: value.deletedAt ?? null
  };
  const result = await env.DB.batch([
    query(env, `
      INSERT INTO enquiries(reference,revision,state,assignee,notes,corrections,updated_at,updated_by,deleted_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(reference) DO UPDATE SET revision=excluded.revision, state=excluded.state,
      assignee=excluded.assignee, notes=excluded.notes, corrections=excluded.corrections,
      updated_at=excluded.updated_at, updated_by=excluded.updated_by, deleted_at=excluded.deleted_at
      WHERE enquiries.revision=?
    `, reference, after.revision, after.state, after.assignee, after.notes,
    JSON.stringify(after.corrections), after.updatedAt, actor, after.deletedAt,
    value.revision),
    query(env, `
      INSERT INTO history(reference,actor,happened_at,before_json,after_json)
      SELECT ?,?,?,?,? WHERE changes()=1
    `, reference, actor, after.updatedAt, JSON.stringify(previous), JSON.stringify(after))
  ]);
  return result[0].meta.changes === 1;
}

function validUpdate(value) {
  if (!value || !Number.isInteger(value.revision) || value.revision < 0 ||
      !states.includes(value.state) || typeof value.assignee !== 'string' || value.assignee.length > 100 ||
      typeof value.notes !== 'string' || value.notes.length > 10000 ||
      !value.corrections || typeof value.corrections !== 'object' || Array.isArray(value.corrections)) return false;
  for (const [key, field] of Object.entries(value.corrections)) {
    if (Object.hasOwn(enquiryFieldLimits, key)) {
      if (typeof field !== 'string' || field.length > enquiryFieldLimits[key]) return false;
      if (['name', 'company', 'requirements'].includes(key) && !field.trim()) return false;
      if (key === 'email' && !/^\S+@[^\s@]+\.[^\s@]+$/.test(field)) return false;
    } else if (key === 'service') {
      if (!Number.isInteger(field) || field < 0 || field > 3) return false;
    } else if (key === 'recipient') {
      if (!Number.isInteger(field) || field < 0 || field > 6) return false;
    } else return false;
  }
  return true;
}

async function createReceipt(env, fields, actor = null) {
  const record = {
    ...fields, receivedAt: new Date().toISOString(), status: 'received',
    source: actor ? 'admin' : 'website', createdBy: actor, consent: actor ? null : true
  };
  const result = await query(env, 'INSERT OR IGNORE INTO receipts VALUES (?, ?, ?)',
    fields.reference, JSON.stringify(record), record.receivedAt).run();
  if (!result.meta.changes) {
    const row = await query(env, 'SELECT original_json FROM receipts WHERE reference=?', fields.reference).first();
    const previous = JSON.parse(row.original_json);
    if (Object.keys(fields).some(key => String(previous[key] ?? '') !== String(fields[key]))) return null;
  }
  return { reference: fields.reference, created: result.meta.changes === 1 };
}

async function detail(env, reference) {
  const row = await query(env, 'SELECT original_json FROM receipts WHERE reference=?', reference).first();
  if (!row) return null;
  const original = JSON.parse(row.original_json);
  const current = await management(env, reference);
  const history = await query(env, 'SELECT * FROM history WHERE reference=? ORDER BY id DESC LIMIT 50', reference).all();
  return {
    original, record: { ...original, ...current.corrections }, management: current,
    history: history.results.map(entry => ({
      actor: entry.actor, at: entry.happened_at,
      before: JSON.parse(entry.before_json), after: JSON.parse(entry.after_json)
    }))
  };
}

async function admin(request, env, url) {
  const path = url.pathname.slice('/api/admin'.length);
  const writing = !['GET', 'HEAD'].includes(request.method);
  if (writing && !sameOrigin(request)) return json({ error: '請從後台頁面操作。' }, 403);
  const account = await query(env, 'SELECT * FROM administrator WHERE id=1').first();
  if (path === '/session' && request.method === 'GET') {
    const session = await getSession(env, request);
    return json({
      authenticated: !!session, setupRequired: !account, setupAllowed: false,
      username: session ? account.username : null, csrf: session?.csrf || null, expires: session?.expires || null
    });
  }
  if (path === '/login' && request.method === 'POST') {
    if (!await takeLimit(env, request, 'login', 10, 900000)) return json({ error: '嘗試次數過多，請稍後再試。' }, 429);
    const value = await inputFor(request);
    if (!value || typeof value.password !== 'string' || value.password.length > 256 ||
      typeof value.username !== 'string' || value.username.length > 100) return json({ error: '請填寫帳號與密碼。' }, 400);
    if (!await verifyPassword(account, value.password) || value.username !== account?.username)
      return json({ error: '帳號或密碼不正確。' }, 401);
    const token = randomBytes(32).toString('hex');
    const csrf = randomBytes(32).toString('hex');
    const expires = Date.now() + 28800000;
    await env.DB.batch([
      query(env, 'DELETE FROM sessions WHERE expires<=?', Date.now()),
      query(env, 'INSERT INTO sessions VALUES (?, ?, ?)', hash(token), csrf, expires)
    ]);
    return json({ username: account.username, csrf, expires }, 200, { 'Set-Cookie': sessionCookie(request, token) });
  }
  const session = await getSession(env, request);
  if (!session) return json({ error: '請先登入後台。' }, 401);
  if (writing && request.headers.get('X-CSRF-Token') !== session.csrf) return json({ error: '驗證已失效，請重新登入。' }, 403);
  if (path === '/logout' && request.method === 'POST') {
    await query(env, 'DELETE FROM sessions WHERE token_hash=?', session.token_hash).run();
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
  }
  if (path === '/password' && request.method === 'POST') {
    if (!await takeLimit(env, request, 'password', 10, 900000)) return json({ error: '請稍後再試。' }, 429);
    const value = await inputFor(request);
    if (!value || !passwordIsValid(value.password) || typeof value.currentPassword !== 'string' ||
      value.currentPassword.length > 256) return json({ error: '新密碼至少 12 字元。' }, 400);
    if (!await verifyPassword(account, value.currentPassword)) return json({ error: '目前密碼不正確。' }, 401);
    const salt = randomBytes(16).toString('hex');
    const password = await passwordHash(value.password, salt);
    const result = await env.DB.batch([
      query(env, 'UPDATE administrator SET salt=?,password_hash=? WHERE id=1 AND password_hash=?', salt, password, account.password_hash),
      query(env, 'DELETE FROM sessions WHERE changes()=1')
    ]);
    if (!result[0].meta.changes) return json({ error: '密碼已變更，請重新登入。' }, 409);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
  }
  if (path === '/enquiries' && request.method === 'POST') {
    const fields = normalizedEnquiry(await inputFor(request), { administrator: true });
    if (!fields) return json({ error: '請確認必填資料、Email、服務及據點。' }, 400);
    const result = await createReceipt(env, fields, account.username);
    return result ? json({ reference: result.reference }, result.created ? 201 : 200) : json({ error: '編號已有其他資料。' }, 409);
  }
  if (path === '/enquiries' && request.method === 'GET') {
    const records = await env.DB.prepare('SELECT reference,original_json FROM receipts ORDER BY received_at DESC').all();
    const managed = await env.DB.prepare('SELECT * FROM enquiries').all();
    const indexed = new Map(managed.results.map(row => [row.reference, row]));
    const filter = url.searchParams.get('deleted');
    const entries = [];
    for (const row of records.results) {
      const original = JSON.parse(row.original_json);
      const managed = indexed.get(row.reference);
      if (managed?.deleted_at && !['all', 'only'].includes(filter)) continue;
      if (!managed?.deleted_at && filter === 'only') continue;
      const record = { ...original, ...JSON.parse(managed?.corrections || '{}') };
      entries.push({
        reference: row.reference, name: record.name, company: record.company, email: record.email,
        service: record.service, recipient: record.recipient, receivedAt: original.receivedAt,
        language: original.language, state: managed?.state || 'new',
        assignee: managed?.assignee || '', deletedAt: managed?.deleted_at || null
      });
    }
    return json({ entries, unreadable: 0 });
  }
  const match = path.match(/^\/enquiries\/([a-f0-9]{32})(\/restore)?$/);
  if (match) {
    const current = await detail(env, match[1]);
    if (!current) return json({ error: '找不到此詢問。' }, 404);
    if (request.method === 'GET' && !match[2]) return json(current);
    const restoring = match[2] && request.method === 'POST';
    if (!restoring && !['PATCH', 'DELETE'].includes(request.method)) return json({ error: '不支援此操作。' }, 405);
    const value = await inputFor(request);
    let updated;
    if (restoring || request.method === 'DELETE') {
      if (!value || !Number.isInteger(value.revision)) return json({ error: '請重新載入。' }, 400);
      if (restoring ? !current.management.deletedAt : current.management.deletedAt) return json({ error: '狀態已變更，請重新載入。' }, 409);
      updated = {
        ...current.management, revision: value.revision,
        deletedAt: restoring ? null : new Date().toISOString()
      };
    } else {
      if (current.management.deletedAt) return json({ error: '請先還原詢問。' }, 409);
      if (!validUpdate(value)) return json({ error: '欄位格式不正確。' }, 400);
      updated = { ...value, deletedAt: null };
    }
    if (!await saveManagement(env, match[1], updated, account.username)) return json({ error: '資料已被其他操作更新，請重新載入。' }, 409);
    return json(await detail(env, match[1]));
  }
  return json({ error: '找不到此操作。' }, 404);
}

async function route(request, env, context) {
  const url = new URL(request.url);
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    url.protocol = 'https:';
    return Response.redirect(url.href, 308);
  }
  if (url.pathname === '/api/version') {
    const asset = await env.ASSETS.fetch(new Request(url.origin + '/version.json'));
    return json(await asset.json());
  }
  if (url.pathname.startsWith('/api/admin/')) return admin(request, env, url);
  if (url.pathname === '/api/enquiries') {
    const origin = request.headers.get('Origin');
    const allowed = (env.NORTHGO_FRONTEND_ORIGINS || '').split(',').map(value => value.trim());
    if (origin && origin !== url.origin && !allowed.includes(origin)) return json({ error: 'Invalid origin' }, 403);
    const headers = origin && origin !== url.origin ? {
      'Access-Control-Allow-Origin': origin, Vary: 'Origin',
      'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'
    } : {};
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, headers);
    if (!await takeLimit(env, request, 'enquiry', 30, 60000)) return json({ error: 'Too many enquiries' }, 429, headers);
    const fields = normalizedEnquiry(await inputFor(request));
    if (!fields) return json({ error: 'Invalid enquiry' }, 400, headers);
    const result = await createReceipt(env, fields);
    return result ? json({ reference: result.reference }, 201, headers) : json({ error: 'Reference already in use' }, 409, headers);
  }
  if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
  if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
  if (url.pathname === '/admin') return Response.redirect(url.origin + '/admin/', 302);
  const assetUrl = new URL(url);
  if (assetUrl.pathname.endsWith('/')) assetUrl.pathname += 'index.html';
  const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
  if (!url.pathname.startsWith('/admin/')) return asset;
  const response = new Response(asset.body, asset);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  return response;
}

export default {
  async fetch(request, env, context) {
    try {
      const response = await route(request, env, context);
      const secured = new Response(response.body, response);
      secured.headers.set('X-Content-Type-Options', 'nosniff');
      secured.headers.set('X-Frame-Options', 'DENY');
      secured.headers.set('Referrer-Policy', 'same-origin');
      if (new URL(request.url).pathname.startsWith('/api/')) {
        context.waitUntil(query(env, 'DELETE FROM rate_limits WHERE expires<?', Date.now()).run());
      }
      return secured;
    } catch (error) {
      console.error('Northgo request failed', error.name);
      return json({ error: '伺服器暫時無法處理，請稍後再試。' }, 500);
    }
  }
};
