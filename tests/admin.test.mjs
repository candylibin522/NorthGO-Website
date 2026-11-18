import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('admin authentication, enquiry maintenance and original receipt protection', async () => {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), 'northgo-admin-'));
  const server = spawn(process.execPath, ['serve-northgo.mjs'], {
    cwd: project, env: {
      ...process.env, PORT: '0', NORTHGO_HOST: '127.0.0.1', NODE_ENV: 'test',
      NORTHGO_DATA_DIR: join(temporary, 'private'), NORTHGO_INBOX_DIR: join(temporary, 'inbox'),
      NORTHGO_FRONTEND_ORIGINS: 'https://northgo.example', NORTHGO_API_URL: ''
    }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', data => { stderr += data; });
  try {
    const base = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(stderr || 'Server startup timed out')), 15000);
      server.once('error', error => { clearTimeout(timeout); reject(error); });
      server.once('exit', code => { clearTimeout(timeout); reject(new Error('Server stopped ' + code + ' ' + stderr)); });
      let output = '';
      server.stdout.on('data', data => {
        output += data;
        const url = output.match(/Northgo: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
        if (url) { clearTimeout(timeout); resolve(url); }
      });
    });
    let cookie = '';
    let csrf = '';
    const request = (path, method = 'GET', body, overrides = {}) => fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json', Origin: base, Cookie: cookie,
        'X-CSRF-Token': csrf, ...overrides
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    assert.equal((await request('/admin/')).status, 200);
    assert.equal((await request('/api/admin/enquiries')).status, 401);
    assert.equal((await (await request('/api/admin/session')).json()).setupAllowed, true);
    const credentials = { username: 'local-qa', password: 'Temporary-QA-password-397' };
    assert.equal((await request('/api/admin/setup', 'POST', credentials, { Origin: 'https://untrusted.example' })).status, 403);
    const setup = await request('/api/admin/setup', 'POST', credentials);
    assert.equal(setup.status, 200);
    const sessionCookie = setup.headers.get('set-cookie');
    assert.match(sessionCookie, /HttpOnly/);
    assert.match(sessionCookie, /SameSite=Strict/);
    cookie = sessionCookie.split(';')[0];
    csrf = (await setup.json()).csrf;
    assert.equal((await request('/api/admin/setup', 'POST', credentials)).status, 403);
    const enquiry = {
      reference: 'a'.repeat(32), name: '測試客戶', company: '<script>QA</script>', email: 'qa@example.invalid',
      requirements: '測試詢問，不寄出', origin: 'Taipei', destination: 'Tokyo',
      service: '0', recipient: '0', language: 'zh', consent: true
    };
    assert.equal((await request('/api/enquiries', 'POST', enquiry)).status, 201);
    assert.equal((await request('/api/enquiries', 'POST', enquiry)).status, 201);
    const crossOrigin = await request('/api/enquiries', 'OPTIONS', undefined, { Origin: 'https://northgo.example' });
    assert.equal(crossOrigin.status, 204);
    assert.equal(crossOrigin.headers.get('access-control-allow-origin'), 'https://northgo.example');
    assert.equal((await request('/api/admin/session', 'POST', {}, { Origin: 'https://northgo.example' })).status, 403);
    assert.equal((await request('/api/enquiries', 'POST', enquiry, { Origin: 'https://untrusted.example' })).status, 403);
    const list = await (await request('/api/admin/enquiries')).json();
    assert.equal(list.entries.length, 1);
    assert.equal(list.entries[0].state, 'new');
    assert.equal(list.entries[0].company, enquiry.company);
    const update = {
      revision: 0, state: 'processing', assignee: '客服', notes: '僅供內部',
      corrections: { name: '修正姓名', requirements: '修正需求' }
    };
    const path = '/api/admin/enquiries/' + enquiry.reference;
    assert.equal((await request(path, 'PATCH', update, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await request(path, 'PATCH', { ...update, corrections: { email: 'invalid' } })).status, 400);
    const responses = await Promise.all([request(path, 'PATCH', update), request(path, 'PATCH', update)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const detail = await (await request(path)).json();
    assert.equal(detail.record.name, '修正姓名');
    assert.equal(detail.original.name, '測試客戶');
    assert.equal(detail.management.revision, 1);
    assert.equal(detail.history.length, 1);
    const original = JSON.parse(await readFile(join(temporary, 'inbox', enquiry.reference + '.json'), 'utf8'));
    assert.equal(original.name, enquiry.name);
    const archived = await request(path, 'PATCH', { ...update, revision: 1, state: 'archived' });
    assert.equal(archived.status, 200);
    assert.equal((await request(path, 'PATCH', { ...update, revision: 2, state: 'new' })).status, 200);
    assert.equal((await request('/api/admin/logout', 'POST', {})).status, 200);
    assert.equal((await request(path)).status, 401);
    cookie = '';
    csrf = '';
    assert.equal((await request('/api/admin/login', 'POST', { ...credentials, password: 'incorrect' })).status, 401);
    const login = await request('/api/admin/login', 'POST', credentials);
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
    csrf = (await login.json()).csrf;
    const newPassword = 'Changed-QA-password-912';
    assert.equal((await request('/api/admin/password', 'POST', {
      currentPassword: credentials.password, password: newPassword
    })).status, 200);
    assert.equal((await request('/api/admin/enquiries')).status, 401);
    cookie = '';
    csrf = '';
    assert.equal((await request('/api/admin/login', 'POST', credentials)).status, 401);
    assert.equal((await request('/api/admin/login', 'POST', { ...credentials, password: newPassword })).status, 200);
    assert.equal((await request('/.northgo-private/admin.sqlite')).status, 404);
  } finally {
    const stopped = new Promise(resolve => server.once('exit', resolve));
    if (server.exitCode === null) { server.kill(); await stopped; }
    await rm(temporary, { recursive: true, force: true });
  }
});
