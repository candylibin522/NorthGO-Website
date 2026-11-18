import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(resolve(root, 'wrangler.jsonc'), 'utf8'));
const origin = config.vars.PUBLIC_SITE_URL;
const temporary = await mkdtemp(resolve(root, '.northgo-private/cloud-qa-'));
const reference = randomBytes(16).toString('hex');
const token = randomBytes(32).toString('hex');
const tokenHash = createHash('sha256').update(token).digest('hex');
const csrf = randomBytes(32).toString('hex');
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const quote = value => "'" + value.replaceAll("'", "''") + "'";

async function execute(sql) {
  const file = resolve(temporary, 'query.sql');
  await writeFile(file, sql, { mode: 0o600 });
  execFileSync(process.execPath, [wrangler, 'd1', 'execute', 'northgo-inquiries', '--remote', '--file', file, '--yes'], {
    cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function request(path, method = 'GET', body, authenticated = false) {
  const headers = resolve(temporary, authenticated ? 'admin-headers.txt' : 'public-headers.txt');
  const args = ['--silent', '--show-error', '--max-time', '20', '--header', '@' + headers,
    '--request', method, '--write-out', '\n%{http_code}', origin + path];
  if (body !== undefined) args.push('--data-binary', '@-');
  const output = execFileSync('curl.exe', args, { input: body === undefined ? undefined : JSON.stringify(body), encoding: 'utf8' });
  const lastBreak = output.lastIndexOf('\n');
  return { status: Number(output.slice(lastBreak + 1)), body: output.slice(0, lastBreak) };
}

try {
  await writeFile(resolve(temporary, 'public-headers.txt'), 'Origin: ' + origin + '\nContent-Type: application/json\n', { mode: 0o600 });
  await writeFile(resolve(temporary, 'admin-headers.txt'),
    'Origin: ' + origin + '\nContent-Type: application/json\nCookie: northgo_session=' + token + '\nX-CSRF-Token: ' + csrf + '\n', { mode: 0o600 });
  await execute('INSERT INTO sessions VALUES (' + quote(tokenHash) + ',' + quote(csrf) + ',' + (Date.now() + 600000) + ');');
  assert.equal((await request('/api/admin/enquiries')).status, 401);
  assert.equal((await request('/api/admin/login', 'POST', { username: 'invalid-qa', password: 'invalid-password' })).status, 401);
  const payload = {
    reference, name: 'Cloudflare 自動驗收', company: 'QA 測試資料', email: 'qa@example.invalid',
    requirements: '僅驗收收件與 CRUD，不寄信', origin: 'Taipei', destination: 'Tokyo',
    dimensions: '1 kg', schedule: '', service: '0', recipient: '0', language: 'zh', consent: true
  };
  const created = await request('/api/enquiries', 'POST', payload);
  assert.equal(created.status, 201);
  assert.equal(JSON.parse(created.body).reference, reference);
  const list = JSON.parse((await request('/api/admin/enquiries', 'GET', undefined, true)).body);
  assert.ok(list.entries.some(entry => entry.reference === reference && entry.name === payload.name));
  const path = '/api/admin/enquiries/' + reference;
  const update = { revision: 0, state: 'processing', assignee: 'QA', notes: '驗收', corrections: { company: 'QA 更新資料' } };
  const updated = await request(path, 'PATCH', update, true);
  assert.equal(updated.status, 200);
  assert.equal(JSON.parse(updated.body).record.company, 'QA 更新資料');
  assert.equal((await request(path, 'PATCH', update, true)).status, 409);
  assert.equal((await request(path, 'DELETE', { revision: 1 }, true)).status, 200);
  const deletedList = JSON.parse((await request('/api/admin/enquiries', 'GET', undefined, true)).body);
  assert.ok(!deletedList.entries.some(entry => entry.reference === reference));
  assert.equal((await request(path + '/restore', 'POST', { revision: 2 }, true)).status, 200);
  const restored = JSON.parse((await request(path, 'GET', undefined, true)).body);
  assert.equal(restored.management.deletedAt, null);
  assert.equal(restored.history.length, 3);
  assert.equal(restored.original.company, payload.company);
  const page = await request('/zh-tw/inquiry/index.html');
  assert.equal(page.status, 200);
  assert.ok(!page.body.includes('data-static-hosting="true"'));
  assert.equal((await request('/admin/')).status, 200);
  assert.equal((await request('/api/admin/logout', 'POST', {}, true)).status, 200);
  assert.equal((await request(path, 'GET', undefined, true)).status, 401);
  console.log('PASS: public frontend receipt, authenticated Read/Update/Delete/Restore, history, conflict and logout.');
} finally {
  try {
    await execute('DELETE FROM history WHERE reference=' + quote(reference) + ';\n' +
      'DELETE FROM enquiries WHERE reference=' + quote(reference) + ';\n' +
      'DELETE FROM receipts WHERE reference=' + quote(reference) + ';\n' +
      'DELETE FROM sessions WHERE token_hash=' + quote(tokenHash) + ';');
    console.log('Removed QA receipt and temporary QA session.');
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
