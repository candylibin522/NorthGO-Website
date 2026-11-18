import { randomBytes } from 'node:crypto';
import { passwordHash, passwordIsValid } from './passwords.mjs';

export const usernamePattern = /^[a-zA-Z0-9_.@-]{3,100}$/;
export const ownerId = 'owner';

export async function findAccount(query, username) {
  const owner = await query('SELECT * FROM administrator WHERE id=1').first();
  if (owner?.username === username) return { ...owner, id: ownerId, role: 'owner' };
  return query('SELECT * FROM team_users WHERE username=? COLLATE BINARY AND enabled=1', username).first();
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
  return query('SELECT id,username,role FROM team_users WHERE id=? AND enabled=1', session.user_id).first();
}

export async function teamRequest({ query, batch, method, path, read, respond }) {
  if (path === '/users' && method === 'GET') {
    const owner = await query('SELECT username FROM administrator WHERE id=1').first();
    const { results } = await query('SELECT id,username,role,enabled FROM team_users ORDER BY username').all();
    return respond({ users: [{ id: ownerId, username: owner.username, role: 'owner', enabled: 1 }, ...results] });
  }
  if (path === '/users' && method === 'POST') {
    const body = await read();
    if (!body || typeof body.username !== 'string' || !usernamePattern.test(body.username) ||
        !['manager', 'viewer'].includes(body.role) || !passwordIsValid(body.password))
      return respond({ error: '請設定有效帳號、角色及至少 12 字元的密碼。' }, 400);
    const owner = await query('SELECT username FROM administrator WHERE id=1').first();
    if (owner.username.toLowerCase() === body.username.toLowerCase())
      return respond({ error: '帳號已存在。' }, 409);
    const id = randomBytes(16).toString('hex');
    const salt = randomBytes(16).toString('hex');
    const result = await query('INSERT OR IGNORE INTO team_users VALUES (?,?,?,?,?,1)',
      id, body.username, salt, await passwordHash(body.password, salt), body.role).run();
    return result.meta.changes ? respond({ id }, 201) : respond({ error: '帳號已存在。' }, 409);
  }
  const id = path.match(/^\/users\/([a-f0-9]{32})$/)?.[1];
  if (!id || method !== 'PATCH') return respond({ error: '找不到此操作。' }, 404);
  const current = await query('SELECT id,role,enabled FROM team_users WHERE id=?', id).first();
  if (!current) return respond({ error: '找不到此帳號。' }, 404);
  const body = await read();
  if (!body || !['manager', 'viewer'].includes(body.role) || typeof body.enabled !== 'boolean' ||
      (body.password !== undefined && !passwordIsValid(body.password)))
    return respond({ error: '請確認角色、狀態及密碼格式。' }, 400);
  const enabled = Number(body.enabled);
  if (!body.password && current.role === body.role && current.enabled === enabled) return respond({ ok: true });
  const changes = [query('UPDATE team_users SET role=?,enabled=? WHERE id=?', body.role, enabled, id)];
  if (body.password) {
    const salt = randomBytes(16).toString('hex');
    changes.push(query('UPDATE team_users SET salt=?,password_hash=? WHERE id=?', salt, await passwordHash(body.password, salt), id));
  }
  changes.push(query('DELETE FROM sessions WHERE user_id=?', id));
  await batch(changes);
  return respond({ ok: true });
}
