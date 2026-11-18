import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export { enquiryFieldLimits, normalizedEnquiry } from './enquiry-validation.mjs';

export async function createEnquiry(inbox, fields, actor = null) {
  await mkdir(inbox, { recursive: true });
  const record = {
    ...fields, receivedAt: new Date().toISOString(), status: 'received',
    source: actor ? 'admin' : 'website', createdBy: actor,
    consent: actor ? null : true
  };
  const file = resolve(inbox, fields.reference + '.json');
  const pending = resolve(inbox, randomUUID() + '.tmp');
  await writeFile(pending, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  try {
    await link(pending, file);
    return { record, created: true };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse(await readFile(file, 'utf8'));
    const conflict = Object.keys(fields).some(key => String(previous[key] ?? '') !== String(fields[key]));
    if (conflict) return null;
    return { record: previous, created: false };
  } finally {
    await unlink(pending).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
