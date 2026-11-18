import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { findAccount, sessionAccount, teamRequest, sqliteTeam, ownerId } from './team-access.mjs';
import { createEnquiry, enquiryFieldLimits, normalizedEnquiry } from './enquiry-repository.mjs';
import {
  administrator, createSession, enquiryStates, managementFor, passwordHash,
  passwordIsValid, saveManagement, sessionForRequest, verifyPassword
} from './admin-store.mjs';

const editableLimits = enquiryFieldLimits;
const attempts = new Map();

export function takeRateLimit(key, maximum, windowMs) {
  const now = Date.now();
  if (attempts.size > 2000) {
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    if (attempts.size > 2000) return false;
  }
  const previous = attempts.get(key);
  const value = previous && previous.until > now ? previous : { count: 0, until: now + windowMs };
  value.count++;
  attempts.set(key, value);
  return value.count <= maximum;
}

export function isLocalRequest(request) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
}

function sameOrigin(request) {
  try {
    return new URL(request.headers.origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function readBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 24000) return null;
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function cookie(response, token, expires) {
  const secure = process.env.NODE_ENV === 'production' || process.env.NORTHGO_SECURE_COOKIES === '1';
  response.setHeader('Set-Cookie', 'northgo_session=' + token +
    '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + expires + (secure ? '; Secure' : ''));
}

async function readRecord(inbox, reference) {
  if (!/^[a-f0-9]{32}$/.test(reference)) return null;
  try {
    const data = JSON.parse(await readFile(resolve(inbox, reference + '.json'), 'utf8'));
    return data.reference === reference ? data : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function validUpdate(input) {
  if (!Number.isInteger(input.revision) || input.revision < 0 ||
    !enquiryStates.includes(input.state) ||
    typeof input.assignee !== 'string' || input.assignee.length > 100 ||
    typeof input.notes !== 'string' || input.notes.length > 10000 ||
    !input.corrections || typeof input.corrections !== 'object' || Array.isArray(input.corrections)) return false;
  for (const [key, value] of Object.entries(input.corrections)) {
    if (Object.hasOwn(editableLimits, key)) {
      if (typeof value !== 'string' || value.length > editableLimits[key]) return false;
      if (['name', 'company', 'requirements'].includes(key) && !value.trim()) return false;
      if (key === 'email' && !/^\S+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
    } else if (key === 'service') {
      if (!Number.isInteger(value) || value < 0 || value > 3) return false;
    } else if (key === 'recipient') {
      if (!Number.isInteger(value) || value < 0 || value > 6) return false;
    } else return false;
  }
  return true;
}

export async function adminApi(request, response, url, { db, inbox, json }) {
  const path = url.pathname.slice('/api/admin'.length);
  const owner = administrator(db);
  const { query, batch } = sqliteTeam(db);
  const writes = !['GET', 'HEAD'].includes(request.method);
  if (writes && !sameOrigin(request)) return json(response, 403, { error: '請從後台頁面操作。' });
  if (path === '/session' && request.method === 'GET') {
    const session = sessionForRequest(db, request);
    const account = await sessionAccount(query, session);
    return json(response, 200, {
      authenticated: !!account,
      setupRequired: !owner,
      setupAllowed: !owner && isLocalRequest(request) && process.env.NODE_ENV !== 'production',
      username: account?.username, role: account?.role,
      csrf: session?.csrf || null,
      expires: session?.expires || null
    });
  }
  if (['/setup', '/login'].includes(path) && request.method === 'POST') {
    if (!takeRateLimit('login:' + request.socket.remoteAddress, 10, 15 * 60 * 1000))
      return json(response, 429, { error: '嘗試次數過多，請 15 分鐘後再試。' });
    const body = await readBody(request);
    if (!body || typeof body.username !== 'string' || typeof body.password !== 'string' ||
      body.username.length > 100 || body.password.length > 256)
      return json(response, 400, { error: '請填寫帳號與密碼。' });
    if (path === '/setup') {
      if (owner || !isLocalRequest(request) || process.env.NODE_ENV === 'production')
        return json(response, 403, { error: '初始帳號只能於未設定帳號的本機伺服器建立。' });
      if (!/^[a-zA-Z0-9_.@-]{3,100}$/.test(body.username) || !passwordIsValid(body.password))
        return json(response, 400, { error: '帳號請用 3–100 個英數字元，密碼至少 12 字元。' });
      const salt = randomBytes(16).toString('hex');
      const hash = await passwordHash(body.password, salt);
      const created = db.prepare('INSERT OR IGNORE INTO administrator VALUES (1, ?, ?, ?)')
        .run(body.username, salt, hash);
      if (!created.changes) return json(response, 409, { error: '帳號已建立，請登入。' });
    }
    const credentials = await findAccount(query, body.username);
    if (!await verifyPassword(credentials, body.password)) {
      return json(response, 401, { error: '帳號或密碼不正確。' });
    }
    const fresh = await findAccount(query, body.username);
    if (!fresh || fresh.password_hash !== credentials.password_hash)
      return json(response, 401, { error: '帳號狀態已變更，請重新登入。' });
    const session = createSession(db, fresh.id);
    cookie(response, session.token, 8 * 60 * 60);
    return json(response, 200, { username: fresh.username, role: fresh.role, csrf: session.csrf, expires: session.expires });
  }
  const session = sessionForRequest(db, request);
  const account = await sessionAccount(query, session);
  if (!account) return json(response, 401, { error: '請先登入後台。' });
  if (writes && request.headers['x-csrf-token'] !== session.csrf)
    return json(response, 403, { error: '驗證已失效，請重新登入。' });
  if (path === '/users' || path.startsWith('/users/')) {
    if (account.role !== 'owner') return json(response, 403, { error: '只有擁有者可管理使用者。' });
    return teamRequest({ query, batch, method: request.method, path,
      read: () => readBody(request), respond: (value, status = 200) => json(response, status, value) });
  }
  if (writes && account.role === 'viewer' && (path === '/enquiries' || path.startsWith('/enquiries/')))
    return json(response, 403, { error: '此帳號僅可查看詢問。' });
  if (path === '/logout' && request.method === 'POST') {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.token_hash);
    cookie(response, '', 0);
    return json(response, 200, { ok: true });
  }
  if (path === '/password' && request.method === 'POST') {
    if (!takeRateLimit('password:' + request.socket.remoteAddress, 10, 15 * 60 * 1000))
      return json(response, 429, { error: '嘗試次數過多，請稍後再試。' });
    const body = await readBody(request);
    if (!body || typeof body.currentPassword !== 'string' || body.currentPassword.length > 256 ||
      !passwordIsValid(body.password)) return json(response, 400, { error: '新密碼至少 12 字元。' });
    const credentials = await findAccount(query, account.username);
    if (!await verifyPassword(credentials, body.currentPassword))
      return json(response, 401, { error: '目前密碼不正確。' });
    const salt = randomBytes(16).toString('hex');
    const hash = await passwordHash(body.password, salt);
    db.exec('BEGIN IMMEDIATE');
    try {
      const updated = account.id === ownerId
        ? db.prepare('UPDATE administrator SET salt=?, password_hash=? WHERE id=1 AND password_hash=?')
          .run(salt, hash, credentials.password_hash)
        : db.prepare('UPDATE team_users SET salt=?,password_hash=? WHERE id=? AND enabled=1 AND password_hash=?')
          .run(salt, hash, account.id, credentials.password_hash);
      if (!updated.changes) {
        db.exec('ROLLBACK');
        return json(response, 409, { error: '密碼已變更，請重新登入。' });
      }
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(account.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    cookie(response, '', 0);
    return json(response, 200, { ok: true });
  }
  if (path === '/enquiries' && request.method === 'POST') {
    const input = await readBody(request);
    const fields = normalizedEnquiry(input, { administrator: true });
    if (!fields) return json(response, 400, { error: '請確認必填資料、Email、服務及據點。' });
    const saved = await createEnquiry(inbox, fields, account.username);
    if (!saved) return json(response, 409, { error: '此編號已有其他資料，請重新新增。' });
    return json(response, saved.created ? 201 : 200, { reference: fields.reference });
  }
  if (path === '/enquiries' && request.method === 'GET') {
    const names = await readdir(inbox).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const entries = [];
    let unreadable = 0;
    for (const name of names.filter(name => /^[a-f0-9]{32}\.json$/.test(name))) {
      try {
        const original = await readRecord(inbox, name.slice(0, -5));
        if (!original) { unreadable++; continue; }
        const management = managementFor(db, original.reference);
        const deletedFilter = url.searchParams.get('deleted');
        if (management.deletedAt && !['all', 'only'].includes(deletedFilter)) continue;
        if (!management.deletedAt && deletedFilter === 'only') continue;
        const corrected = { ...original, ...management.corrections };
        entries.push({
          reference: original.reference, name: corrected.name, company: corrected.company,
          email: corrected.email, service: corrected.service, recipient: corrected.recipient,
          receivedAt: original.receivedAt, language: original.language,
          state: management.state, assignee: management.assignee, deletedAt: management.deletedAt
        });
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        unreadable++;
      }
    }
    entries.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
    return json(response, 200, { entries, unreadable });
  }
  const match = path.match(/^\/enquiries\/([a-f0-9]{32})(\/restore)?$/);
  const reference = match?.[1];
  if (reference && (['GET', 'PATCH', 'DELETE'].includes(request.method) || match[2] && request.method === 'POST')) {
    const original = await readRecord(inbox, reference);
    if (!original) return json(response, 404, { error: '找不到此詢問。' });
    const existing = managementFor(db, reference);
    const restoring = match[2] && request.method === 'POST';
    if (match[2] && !restoring) return json(response, 405, { error: '不支援此操作。' });
    if (restoring || request.method === 'DELETE') {
      const input = await readBody(request);
      if (!input || !Number.isInteger(input.revision)) return json(response, 400, { error: '請重新載入此詢問。' });
      if ((restoring && !existing.deletedAt) || (!restoring && existing.deletedAt))
        return json(response, 409, { error: '此詢問的刪除狀態已變更，請重新載入。' });
      const saved = saveManagement(db, reference, {
        ...existing, revision: input.revision, deletedAt: restoring ? null : new Date().toISOString()
      }, account.username);
      if (!saved) return json(response, 409, { error: '其他操作已更新此詢問，請重新載入。' });
    } else if (request.method === 'PATCH') {
      if (existing.deletedAt) return json(response, 409, { error: '請先從回收筒還原再修改。' });
      const input = await readBody(request);
      if (!input || !validUpdate(input)) return json(response, 400, { error: '欄位格式不正確，請檢查後重試。' });
      const saved = saveManagement(db, reference, input, account.username);
      if (!saved) return json(response, 409, { error: '其他操作已更新此詢問。請重新載入再修改。' });
    }
    const management = managementFor(db, reference);
    const history = db.prepare('SELECT actor, happened_at, before_json, after_json FROM history WHERE reference=? ORDER BY id DESC LIMIT 50')
      .all(reference).map(item => ({
        actor: item.actor, at: item.happened_at,
        before: JSON.parse(item.before_json), after: JSON.parse(item.after_json)
      }));
    const file = resolve(inbox, reference + '.json');
    return json(response, 200, {
      original, record: { ...original, ...management.corrections }, management, history,
      deliveryUpdatedAt: (await stat(file)).mtime.toISOString()
    });
  }
  return json(response, 404, { error: '找不到此操作。' });
}
