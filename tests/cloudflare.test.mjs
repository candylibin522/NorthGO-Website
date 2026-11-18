import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';
import { passwordHash } from '../backend/passwords.mjs';

function d1Adapter(db) {
  return {
    prepare(sql) {
      const statement = {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() { return db.prepare(sql).get(...this.args) || null; },
        async all() { return { results: db.prepare(sql).all(...this.args) }; },
        async run() {
          const result = db.prepare(sql).run(...this.args);
          return { success: true, meta: { changes: Number(result.changes) } };
        }
      };
      return statement;
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

test('Cloudflare Worker shares authenticated CRUD with the frontend', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(await readFile(new URL('../cloudflare/migrations/0001_inquiries.sql', import.meta.url), 'utf8'));
  const password = 'Cloud-QA-password-129';
  db.prepare('INSERT INTO administrator VALUES (1, ?, ?, ?)').run('qa-admin', 'test-salt', await passwordHash(password, 'test-salt'));
  const env = { DB: d1Adapter(db), ASSETS: { fetch: async () => Response.json({ version: '1.4.0' }) } };
  let cookie = '', csrf = '';
  const request = async (path, method = 'GET', body, extra = {}) => {
    const pending = [];
    const response = await worker.fetch(new Request('https://northgo.example' + path, {
      method, headers: {
        Origin: 'https://northgo.example', 'Content-Type': 'application/json',
        Cookie: cookie, 'X-CSRF-Token': csrf, 'CF-Connecting-IP': '192.0.2.1', ...extra
      }, body: body === undefined ? undefined : JSON.stringify(body)
    }), env, { waitUntil: promise => pending.push(promise) });
    await Promise.all(pending);
    return response;
  };
  try {
    assert.equal((await request('/api/admin/enquiries')).status, 401);
    assert.equal((await request('/api/admin/login', 'POST', { username: 'qa-admin', password: 'wrong' })).status, 401);
    const login = await request('/api/admin/login', 'POST', { username: 'qa-admin', password });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
    csrf = (await login.json()).csrf;
    const payload = {
      name: '雲端測試', company: 'QA', email: 'qa@example.invalid', requirements: '測試，不寄出',
      service: '0', recipient: '0', language: 'zh', consent: true, reference: 'c'.repeat(32)
    };
    assert.equal((await request('/api/enquiries', 'POST', payload)).status, 201);
    assert.equal((await request('/api/enquiries', 'POST', payload)).status, 201);
    const path = '/api/admin/enquiries/' + payload.reference;
    assert.equal((await (await request('/api/admin/enquiries')).json()).entries.length, 1);
    const update = { revision: 0, state: 'processing', assignee: 'QA', notes: '內部', corrections: { name: '修正' } };
    assert.equal((await request(path, 'PATCH', update, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await request(path, 'PATCH', update)).status, 200);
    assert.equal((await request(path, 'PATCH', update)).status, 409);
    assert.equal((await request(path, 'PATCH', { ...update, revision: 1, state: 'replied' })).status, 200);
    assert.equal((await request(path, 'DELETE', { revision: 2 })).status, 200);
    assert.equal((await (await request('/api/admin/enquiries')).json()).entries.length, 0);
    assert.equal((await request(path + '/restore', 'POST', { revision: 3 })).status, 200);
    const result = await (await request(path)).json();
    assert.equal(result.record.name, '修正');
    assert.equal(result.original.name, payload.name);
    assert.equal(result.history.length, 4);
    assert.equal(result.management.revision, 4);
    assert.equal((await request('/api/admin/logout', 'POST', {})).status, 200);
    assert.equal((await request(path)).status, 401);
  } finally { db.close(); }
});
