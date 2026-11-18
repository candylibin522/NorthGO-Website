import { randomBytes } from 'node:crypto';
import { passwordHash, passwordIsValid } from './passwords.mjs';

export const usernamePattern = /^[a-zA-Z0-9_.@-]{3,100}$/;
export const ownerId = 'owner';
export const canManageUsers = role => role === 'owner' || role === 'admin';

const delegatedRoles = ['manager', 'viewer'];
const userSummary = 'id,username,role,enabled,deleted_at,revision';
const canEditUser = (actor, user) => actor.role === 'owner' || delegatedRoles.includes(user.role);
const actorIsAuthorized = `(? = 'owner' OR EXISTS (
  SELECT 1 FROM team_users WHERE id=? AND role='admin' AND enabled=1 AND deleted_at IS NULL
))`;

export async function findAccount(query, username) {
  const owner = await query('SELECT * FROM administrator WHERE id=1').first();
  if (owner?.username === username) return { ...owner, id: ownerId, role: 'owner' };
  return query('SELECT * FROM team_users WHERE username=? COLLATE BINARY AND enabled=1 AND deleted_at IS NULL', username).first();
}

export function sqliteTeam(db) {
  return {
    query(sql, ...args) {
      const statement = db.prepare(sql);
      return {
        first: () => statement.get(...args),
        all: () => ({ results: statement.all(...args) }),
        run: () => ({ meta: statement.run(...args) })
      };
    },
    batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(statement => statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

export async function sessionAccount(query, session) {
  if (!session) return null;
  if (session.user_id === ownerId) {
    const owner = await query('SELECT username FROM administrator WHERE id=1').first();
    return owner ? { ...owner, id: ownerId, role: 'owner' } : null;
  }
  return query('SELECT id,username,role FROM team_users WHERE id=? AND enabled=1 AND deleted_at IS NULL', session.user_id).first();
}

export async function teamRequest({ query, batch, method, path, read, respond, actor }) {
  if (!canManageUsers(actor.role)) return respond({ error: '目前帳號無法管理使用者。' }, 403);
  const availableRoles = actor.role === 'owner' ? ['admin', ...delegatedRoles] : delegatedRoles;
  const owner = await query('SELECT username FROM administrator WHERE id=1').first();
  const validUsername = username => typeof username === 'string' && usernamePattern.test(username);
  const isOwnerName = username => owner.username.toLowerCase() === username.toLowerCase();
  if (path === '/users' && method === 'GET') {
    const { results } = await query(`SELECT ${userSummary} FROM team_users ORDER BY username`).all();
    return respond({ availableRoles, users: [
      { id: ownerId, username: owner.username, role: 'owner', enabled: 1, canEdit: false },
      ...results.map(user => ({ ...user, canEdit: canEditUser(actor, user) }))
    ] });
  }
  if (path === '/users' && method === 'POST') {
    const body = await read();
    if (!body || !validUsername(body.username) || !passwordIsValid(body.password))
      return respond({ error: '請設定有效帳號、角色及至少 12 字元的密碼。' }, 400);
    if (!availableRoles.includes(body.role)) return respond({ error: '目前帳號無法分配此角色。' }, 403);
    if (isOwnerName(body.username)) return respond({ error: '帳號已存在。' }, 409);
    const id = randomBytes(16).toString('hex');
    const salt = randomBytes(16).toString('hex');
    const result = await query(`INSERT OR IGNORE INTO team_users (id,username,salt,password_hash,role)
      SELECT ?,?,?,?,? WHERE ${actorIsAuthorized}`,
      id, body.username, salt, await passwordHash(body.password, salt), body.role, actor.role, actor.id).run();
    return result.meta.changes ? respond({ id }, 201) : respond({ error: '帳號已存在或管理權限已變更。' }, 409);
  }
  const match = path.match(/^\/users\/([a-f0-9]{32})(\/restore)?$/);
  const restoring = !!match?.[2];
  if (!match || (restoring ? method !== 'POST' : !['PATCH', 'DELETE'].includes(method)))
    return respond({ error: '找不到此操作。' }, 404);
  const id = match[1];
  const current = await query(`SELECT ${userSummary} FROM team_users WHERE id=?`, id).first();
  if (!current) return respond({ error: '找不到此帳號。' }, 404);
  if (!canEditUser(actor, current)) return respond({ error: '目前帳號無法管理此使用者。' }, 403);
  if (restoring !== Boolean(current.deleted_at))
    return respond({ error: '帳號狀態已變更，請重新整理清單。' }, 409);
  const body = await read();
  if (body?.revision !== undefined && body.revision !== current.revision)
    return respond({ error: '此帳號已由其他管理員更新，請重新整理清單。' }, 409);
  let settings = 'enabled=0,deleted_at=?';
  let values = [restoring ? null : new Date().toISOString()];
  if (method === 'PATCH') {
    const username = body?.username ?? current.username;
    if (!body || !validUsername(username) || typeof body.enabled !== 'boolean' ||
        (body.password !== undefined && !passwordIsValid(body.password)))
      return respond({ error: '請確認帳號、角色、狀態及密碼格式。' }, 400);
    if (!availableRoles.includes(body.role)) return respond({ error: '目前帳號無法分配此角色。' }, 403);
    if (isOwnerName(username)) return respond({ error: '帳號已存在。' }, 409);
    const enabled = Number(body.enabled);
    if (!body.password && username === current.username && current.role === body.role && current.enabled === enabled)
      return respond({ ok: true });
    settings = 'username=?,role=?,enabled=?';
    values = [username, body.role, enabled];
    if (body.password) {
      const salt = randomBytes(16).toString('hex');
      settings += ',salt=?,password_hash=?';
      values.push(salt, await passwordHash(body.password, salt));
    }
  }
  const [result] = await batch([
    query(`UPDATE OR IGNORE team_users SET ${settings},revision=revision+1
      WHERE id=? AND revision=? AND ${actorIsAuthorized}`, ...values, id, current.revision, actor.role, actor.id),
    query('DELETE FROM sessions WHERE user_id=? AND changes()=1', id)
  ]);
  return result.meta.changes ? respond({ ok: true })
    : respond({ error: '帳號已存在，或資料已更新。請重新整理清單。' }, 409);
}
