import process from 'node:process';
import console from 'node:console';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const next = resolve(root, 'node_modules/next/dist/bin/next');
if (!existsSync(next)) throw new Error('Install the locked dependencies first: npm ci');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding:'utf8'}).trim();
const env = {
  ...process.env,
  DEV_MOCK_JMAP: 'true',
  // Server-side sign-in verification needs an absolute URL. Both the
  // browser and the verifier use this same loopback-only synthetic endpoint.
  JMAP_SERVER_URL: 'http://127.0.0.1:3000/api/dev-jmap',
  APP_NAME: 'Memail',
  APP_SHORT_NAME: 'Memail',
  APP_DESCRIPTION: 'A calmer place for email. Built on Bulwark and JMAP.',
  APP_LOGO_LIGHT_URL: '/branding/memail/mark.svg',
  APP_LOGO_DARK_URL: '/branding/memail/mark-dark.svg',
  LOGIN_LOGO_LIGHT_URL: '/branding/memail/mark.svg',
  LOGIN_LOGO_DARK_URL: '/branding/memail/mark-dark.svg',
  LOGIN_COMPANY_NAME: 'Memail by Saivra',
  LOGIN_WEBSITE_URL: 'https://github.com/Saivra/memail',
  FAVICON_URL: '/branding/memail/mark.svg',
  PWA_ICON_URL: '/branding/memail/mark.svg',
  PWA_THEME_COLOR: '#263b32',
  PWA_BACKGROUND_COLOR: '#ffffff',
  SOURCE_CODE_URL: `https://github.com/Saivra/memail/tree/${commit}`,
  // Synthetic mailbox only. Never reuse a production session secret here.
  SESSION_SECRET: randomBytes(32).toString('hex'),
};
for (const script of ['scripts/build-pst-worker.mjs', 'scripts/build-plugin-sandbox.mjs']) {
  execFileSync(process.execPath, [script], {cwd:root, env, stdio:'inherit'});
}
console.log('Memail demo: http://127.0.0.1:3000 - synthetic mail only; the built-in demo signs in as dev@localhost.');
const child = spawn(process.execPath, [next, 'dev', '--hostname', '127.0.0.1', '--port', '3000'], {cwd:root, env, stdio:'inherit'});
child.on('error', error => { console.error(error.message); process.exitCode=1; });
child.on('exit', code => { process.exitCode=code ?? 1; });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
