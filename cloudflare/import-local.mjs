import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(process.env.NORTHGO_DATA_DIR || resolve(root, '.northgo-private'));
const inbox = resolve(process.env.NORTHGO_INBOX_DIR || resolve(root, '.northgo-inbox'));
const database = new DatabaseSync(resolve(directory, 'admin.sqlite'), { readOnly: true });
const account = database.prepare('SELECT id,username,salt,password_hash FROM administrator WHERE id=1').get();
if (!account) throw new Error('Create the local administrator before importing.');
const sqlValue = value => value == null ? 'NULL' : typeof value === 'number' ? String(value) : "'" + String(value).replaceAll("'", "''") + "'";
const statements = [];
const insert = (table, record) => statements.push('INSERT OR IGNORE INTO ' + table +
  '(' + Object.keys(record).join(',') + ') VALUES (' + Object.values(record).map(sqlValue).join(',') + ');');
insert('administrator', account);
const names = await readdir(inbox).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
let count = 0;
for (const name of names.filter(name => /^[a-f0-9]{32}\.json$/.test(name))) {
  const original = JSON.parse(await readFile(resolve(inbox, name), 'utf8'));
  if (original.reference !== name.slice(0, -5)) throw new Error('Invalid local reference');
  insert('receipts', { reference: original.reference, original_json: JSON.stringify(original), received_at: original.receivedAt });
  const metadata = database.prepare('SELECT * FROM enquiries WHERE reference=?').get(original.reference);
  if (metadata) insert('enquiries', metadata);
  const history = database.prepare('SELECT reference,actor,happened_at,before_json,after_json FROM history WHERE reference=? ORDER BY id').all(original.reference);
  // History has no cross-database identifier, so only import it on the initial migration.
  if (process.argv.includes('--include-history')) for (const entry of history) {
    statements.push('INSERT INTO history(reference,actor,happened_at,before_json,after_json) SELECT ' +
      Object.values(entry).map(sqlValue).join(',') + ' WHERE NOT EXISTS (SELECT 1 FROM history WHERE reference=' +
      sqlValue(entry.reference) + ' AND happened_at=' + sqlValue(entry.happened_at) + ' AND after_json=' + sqlValue(entry.after_json) + ');');
  }
  count++;
}
database.close();
await mkdir(directory, { recursive: true });
const temporary = resolve(directory, 'cloudflare-import-' + randomUUID() + '.sql');
try {
  await writeFile(temporary, statements.join('\n'), { flag: 'wx', mode: 0o600 });
  const remote = process.argv.includes('--remote') ? '--remote' : '--local';
  const result = spawnSync(process.execPath, [
    resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'northgo-inquiries',
    remote, '--file', temporary, '--yes'
  ], { cwd: root, stdio: 'inherit', env: process.env });
  if (result.status !== 0) throw new Error('D1 import failed');
  console.log('Imported administrator hash and ' + count + ' local receipts. Plaintext credentials were not exported.');
} finally {
  await unlink(temporary);
}
