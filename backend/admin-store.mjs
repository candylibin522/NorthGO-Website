import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
export { passwordHash, verifyPassword, passwordIsValid } from './passwords.mjs';

export const enquiryStates = ['new', 'processing', 'replied', 'archived'];

export function openAdminStore(project) {
  const directory = resolve(process.env.NORTHGO_DATA_DIR || resolve(project, '.northgo-private'));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolve(directory, 'admin.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS administrator (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS enquiries (
      reference TEXT PRIMARY KEY, revision INTEGER NOT NULL,
      state TEXT NOT NULL, assignee TEXT NOT NULL, notes TEXT NOT NULL,
      corrections TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY, reference TEXT NOT NULL, actor TEXT NOT NULL,
      happened_at TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL
    );
  `);
  const columns = db.prepare('PRAGMA table_info(enquiries)').all();
  if (!columns.some(column => column.name === 'deleted_at')) {
    db.exec('ALTER TABLE enquiries ADD COLUMN deleted_at TEXT');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('PRAGMA table_info(sessions)').all().some(column => column.name === 'user_id')) {
      db.exec(readFileSync(new URL('../cloudflare/migrations/0002_team_users.sql', import.meta.url), 'utf8'));
    }
    if (!db.prepare('PRAGMA table_info(team_users)').all().some(column => column.name === 'revision')) {
      db.exec(readFileSync(new URL('../cloudflare/migrations/0003_team_management.sql', import.meta.url), 'utf8'));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return db;
}

export function administrator(db) {
  return db.prepare('SELECT * FROM administrator WHERE id = 1').get();
}


export function createSession(db, userId) {
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  const expires = Date.now() + 8 * 60 * 60 * 1000;
  db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
  db.prepare('INSERT INTO sessions(token_hash,csrf,expires,user_id) VALUES (?, ?, ?, ?)').run(tokenHash(token), csrf, expires, userId);
  return { token, csrf, expires };
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function sessionForRequest(db, request) {
  const token = (request.headers.cookie || '').split(';')
    .map(part => part.trim()).find(part => part.startsWith('northgo_session='))?.slice(16);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires > ?')
    .get(tokenHash(token), Date.now()) || null;
}

export function managementFor(db, reference) {
  const row = db.prepare('SELECT * FROM enquiries WHERE reference = ?').get(reference);
  if (!row) return { revision: 0, state: 'new', assignee: '', notes: '', corrections: {}, updatedAt: null, updatedBy: null, deletedAt: null };
  return {
    revision: row.revision, state: row.state, assignee: row.assignee, notes: row.notes,
    corrections: JSON.parse(row.corrections), updatedAt: row.updated_at, updatedBy: row.updated_by,
    deletedAt: row.deleted_at
  };
}

export function saveManagement(db, reference, input, actor) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = managementFor(db, reference);
    if (previous.revision !== input.revision) {
      db.exec('ROLLBACK');
      return null;
    }
    const updatedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO enquiries(reference, revision, state, assignee, notes, corrections, updated_at, updated_by, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(reference) DO UPDATE SET revision=excluded.revision,
      state=excluded.state, assignee=excluded.assignee, notes=excluded.notes,
      corrections=excluded.corrections, updated_at=excluded.updated_at, updated_by=excluded.updated_by,
      deleted_at=excluded.deleted_at
    `).run(reference, previous.revision + 1, input.state, input.assignee, input.notes,
      JSON.stringify(input.corrections), updatedAt, actor, input.deletedAt === undefined ? previous.deletedAt : input.deletedAt);
    const result = managementFor(db, reference);
    db.prepare('INSERT INTO history(reference, actor, happened_at, before_json, after_json) VALUES (?, ?, ?, ?, ?)')
      .run(reference, actor, updatedAt, JSON.stringify(previous), JSON.stringify(result));
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
