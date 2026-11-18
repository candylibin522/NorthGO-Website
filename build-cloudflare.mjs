import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('./', import.meta.url));
const configuration = JSON.parse(await readFile(new URL('wrangler.jsonc', import.meta.url), 'utf8'));
const result = spawnSync(process.execPath, ['build-northgo.mjs'], {
  cwd: project, stdio: 'inherit',
  env: {
    ...process.env, NORTHGO_STATIC_HOSTING: '0', NORTHGO_API_URL: '',
    NORTHGO_SITE_URL: process.env.NORTHGO_SITE_URL || configuration.vars?.PUBLIC_SITE_URL || ''
  }
});
if (result.status !== 0) process.exit(1);
await mkdir(new URL('northgo-site/admin/', import.meta.url), { recursive: true });
await cp(new URL('admin/', import.meta.url), new URL('northgo-site/admin/', import.meta.url), { recursive: true });
await writeFile(new URL('northgo-site/version.json', import.meta.url),
  JSON.stringify({ version: (await readFile(new URL('VERSION', import.meta.url), 'utf8')).trim() }));
console.log('Cloudflare assets include frontend and admin. Private data is excluded.');
